const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { sign, protect } = require('../middleware/auth');
const { awardPoints } = require('../services/points');
const throttle = require('../middleware/throttle');

const router = express.Router();

// OTP delivery is pluggable: until an SMS/email provider is connected, the code
// is returned in the response in non-production so the flow is fully testable.
const OTP_TTL_MIN = 10;
const EXPOSE_OTP = process.env.EXPOSE_OTP === 'true' || process.env.NODE_ENV !== 'production';

function makeOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

const MAX_ATTEMPTS = 5;            // wrong codes before the code is burnt
const RESEND_COOLDOWN_SEC = 60;    // one new code per minute
const MAX_CODES_PER_HOUR = 5;      // per account

function hashTicket(ticket) {
  return crypto.createHash('sha256').update(String(ticket)).digest('hex');
}

/* 🔒 Every code is bound to a TICKET: a random secret given only to the
   person who just registered, or who just logged in with the right password.
   verify-otp and resend-otp need that ticket. The citizen id alone (1, 2, 3…)
   is no longer enough, which is what let anyone take over any account.
   Issuing a new code cancels the older ones. */
async function issueOtp(citizenId, channel, purpose = 'verify', ticketHash = null) {
  const code = makeOtp();
  let ticket = null;
  if (!ticketHash) {
    ticket = crypto.randomBytes(24).toString('base64url');
    ticketHash = hashTicket(ticket);
  }
  await query(
    'UPDATE otp_codes SET consumed_at = NOW() WHERE citizen_id = $1 AND consumed_at IS NULL',
    [citizenId]
  );
  await query(
    `INSERT INTO otp_codes (citizen_id, code, channel, purpose, expires_at, ticket_hash)
     VALUES ($1,$2,$3,$4, NOW() + ($5 || ' minutes')::interval, $6)`,
    [citizenId, code, channel, purpose, String(OTP_TTL_MIN), ticketHash]
  );
  // TODO: wire SendGrid/Twilio here — the rest of the flow already works.
  return { code, ticket };
}

function isVerified(c) {
  return !!(c.email_verified || c.phone_verified);
}

// POST /api/auth/register — create a citizen account and send a verification code
router.post('/register',
  body('full_name').trim().notEmpty().withMessage('Nom complet requis'),
  body('password').isLength({ min: 6 }).withMessage('Mot de passe : 6 caractères minimum'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: errors.array()[0].msg });
    }
    try {
      const { full_name, password } = req.body;
      const email = (req.body.email || '').trim().toLowerCase() || null;
      const phone = (req.body.phone || '').trim() || null;
      if (!email && !phone) {
        return res.status(400).json({ success: false, message: 'Email ou téléphone requis' });
      }

      const dupe = await query(
        'SELECT id FROM citizens WHERE (email IS NOT NULL AND email = $1) OR (phone IS NOT NULL AND phone = $2)',
        [email, phone]
      );
      if (dupe.rows.length) {
        return res.status(400).json({ success: false, message: 'Un compte existe déjà avec ces informations' });
      }

      const hash = await bcrypt.hash(password, 10);
      const { rows } = await query(
        `INSERT INTO citizens (full_name, email, phone, password_hash, department, commune, birth_year)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [full_name.trim(), email, phone, hash,
         req.body.department || null, req.body.commune || null, req.body.birth_year || null]
      );
      const citizen = rows[0];

      const channel = email ? 'email' : 'sms';
      const { code, ticket } = await issueOtp(citizen.id, channel);

      await query(
        `INSERT INTO notifications (citizen_id, title, body)
         VALUES ($1,$2,$3)`,
        [citizen.id, 'Bienvenue sur STARFLEX',
         'Votre compte citoyen est créé. Vérifiez votre compte pour commencer votre parcours civique.']
      );

      res.status(201).json({
        success: true,
        message: `Code de vérification envoyé par ${channel === 'email' ? 'email' : 'SMS'}`,
        data: { citizen_id: citizen.id, channel, ticket, otp: EXPOSE_OTP ? code : undefined }
      });
    } catch (e) {
      console.error('register error', e.message);
      res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
  }
);

// POST /api/auth/verify-otp — confirm the code, activate the account, return a token
// 🔒 Needs the ticket from register/login. Only for accounts NOT yet verified:
// a verified account signs in with its password, never with a code.
router.post('/verify-otp', async (req, res) => {
  try {
    const { ticket, code } = req.body;
    if (!ticket || !code) {
      return res.status(400).json({ success: false, code: 'ticket_required', message: 'Session de vérification expirée — reconnectez-vous pour recevoir un nouveau code' });
    }
    const { rows } = await query(
      `SELECT o.*, c.email_verified, c.phone_verified, c.status
         FROM otp_codes o JOIN citizens c ON c.id = o.citizen_id
        WHERE o.ticket_hash = $1 AND o.consumed_at IS NULL AND o.expires_at > NOW()
        ORDER BY o.id DESC LIMIT 1`,
      [hashTicket(ticket)]
    );
    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'Code invalide ou expiré' });
    }
    const otp = rows[0];

    if (isVerified(otp) || otp.status !== 'active') {
      await query('UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1', [otp.id]);
      return res.status(400).json({ success: false, code: 'already_verified', message: 'Ce compte est déjà vérifié — connectez-vous avec votre mot de passe' });
    }

    const given = String(code).trim();
    const match = given.length === otp.code.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(otp.code));
    if (!match) {
      const n = otp.attempts + 1;
      if (n >= MAX_ATTEMPTS) {
        await query('UPDATE otp_codes SET attempts = $2, consumed_at = NOW() WHERE id = $1', [otp.id, n]);
        return res.status(429).json({ success: false, code: 'too_many_attempts', message: 'Trop d\'essais — demandez un nouveau code' });
      }
      await query('UPDATE otp_codes SET attempts = $2 WHERE id = $1', [otp.id, n]);
      return res.status(400).json({ success: false, message: 'Code invalide ou expiré' });
    }

    // Consume atomically so two requests with the same code cannot both win.
    const used = await query(
      'UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL RETURNING id',
      [otp.id]
    );
    if (!used.rows.length) {
      return res.status(400).json({ success: false, message: 'Code invalide ou expiré' });
    }

    const field = otp.channel === 'email' ? 'email_verified' : 'phone_verified';
    const updated = await query(
      `UPDATE citizens SET ${field} = TRUE, updated_at = NOW()
        WHERE id = $1 AND NOT email_verified AND NOT phone_verified RETURNING *`,
      [otp.citizen_id]
    );
    if (!updated.rows.length) {
      return res.status(400).json({ success: false, code: 'already_verified', message: 'Ce compte est déjà vérifié — connectez-vous avec votre mot de passe' });
    }
    const citizen = updated.rows[0];

    // First verification is itself a civic step — awarded ONCE per account.
    const prior = await query(
      "SELECT 1 FROM point_events WHERE citizen_id = $1 AND reason = 'Compte vérifié' LIMIT 1",
      [citizen.id]
    );
    if (!prior.rows.length) {
      await awardPoints(citizen.id, 5, 'Compte vérifié', 'citizen', citizen.id);
    }
    const fresh = await query('SELECT * FROM citizens WHERE id = $1', [citizen.id]);

    res.json({
      success: true,
      message: 'Compte vérifié',
      token: sign(fresh.rows[0]),
      data: publicCitizen(fresh.rows[0])
    });
  } catch (e) {
    console.error('verify-otp error', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// POST /api/auth/resend-otp
// 🔒 Needs the ticket. Never for a verified account. Rate-limited per account.
router.post('/resend-otp', async (req, res) => {
  try {
    const { ticket } = req.body;
    if (!ticket) {
      return res.status(400).json({ success: false, code: 'ticket_required', message: 'Session de vérification expirée — reconnectez-vous pour recevoir un nouveau code' });
    }
    const th = hashTicket(ticket);
    const { rows } = await query(
      `SELECT c.* FROM otp_codes o JOIN citizens c ON c.id = o.citizen_id
        WHERE o.ticket_hash = $1 AND o.created_at > NOW() - INTERVAL '1 hour'
        ORDER BY o.id DESC LIMIT 1`,
      [th]
    );
    if (!rows.length) {
      return res.status(400).json({ success: false, code: 'ticket_required', message: 'Session de vérification expirée — reconnectez-vous pour recevoir un nouveau code' });
    }
    const citizen = rows[0];
    if (isVerified(citizen) || citizen.status !== 'active') {
      return res.status(400).json({ success: false, code: 'already_verified', message: 'Ce compte est déjà vérifié — connectez-vous avec votre mot de passe' });
    }
    const recent = await query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(EXTRACT(EPOCH FROM (NOW() - MAX(created_at))), 99999)::int AS age
         FROM otp_codes WHERE citizen_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [citizen.id]
    );
    const { n, age } = recent.rows[0];
    if (age < RESEND_COOLDOWN_SEC) {
      return res.status(429).json({ success: false, code: 'wait', message: 'Patientez une minute avant de redemander un code' });
    }
    if (n >= MAX_CODES_PER_HOUR) {
      return res.status(429).json({ success: false, code: 'too_many_codes', message: 'Trop de codes demandés — réessayez dans une heure' });
    }
    const channel = citizen.email ? 'email' : 'sms';
    const { code } = await issueOtp(citizen.id, channel, 'verify', th);
    res.json({ success: true, message: 'Nouveau code envoyé', data: { otp: EXPOSE_OTP ? code : undefined } });
  } catch (e) {
    console.error('resend-otp error', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const identifier = (req.body.identifier || req.body.email || req.body.phone || '').trim();
    const { password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: 'Identifiant et mot de passe requis' });
    }

    if (!throttle.allow(req, res, 'citizen', identifier)) return;
    const { rows } = await query(
      'SELECT * FROM citizens WHERE email = $1 OR phone = $1',
      [identifier.toLowerCase()]
    );
    if (!rows.length) {
      throttle.fail(req, 'citizen', identifier);
      return res.status(400).json({ success: false, message: 'Identifiants incorrects' });
    }
    const citizen = rows[0];
    const ok = await bcrypt.compare(password, citizen.password_hash);
    if (!ok) {
      throttle.fail(req, 'citizen', identifier);
      return res.status(400).json({ success: false, message: 'Identifiants incorrects' });
    }
    throttle.succeed('citizen', identifier);
    if (citizen.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Compte suspendu' });
    }

    // Unverified accounts must finish OTP before they get a session.
    if (!citizen.email_verified && !citizen.phone_verified) {
      const channel = citizen.email ? 'email' : 'sms';
      const { code, ticket } = await issueOtp(citizen.id, channel);
      return res.status(403).json({
        success: false,
        code: 'verification_required',
        message: 'Compte non vérifié — un nouveau code vient d\'être envoyé',
        data: { citizen_id: citizen.id, channel, ticket, otp: EXPOSE_OTP ? code : undefined }
      });
    }

    res.json({ success: true, token: sign(citizen), data: publicCitizen(citizen) });
  } catch (e) {
    console.error('login error', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  res.json({ success: true, data: publicCitizen(req.citizen) });
});

// PUT /api/auth/profile — complete/update the citizen profile
router.put('/profile', protect, async (req, res) => {
  try {
    const fields = ['full_name', 'department', 'commune', 'birth_year'];
    const sets = [];
    const vals = [];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) { vals.push(req.body[f]); sets.push(`${f} = $${vals.length}`); }
    });
    if (!sets.length) return res.json({ success: true, data: publicCitizen(req.citizen) });

    vals.push(req.citizen.id);
    const { rows } = await query(
      `UPDATE citizens SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    const c = rows[0];

    // Mark the profile complete once the essentials are filled in.
    if (!c.profile_complete && c.full_name && c.department && c.commune) {
      await query('UPDATE citizens SET profile_complete = TRUE WHERE id = $1', [c.id]);
      await awardPoints(c.id, 10, 'Profil complété', 'citizen', c.id);
      c.profile_complete = true;
    }

    res.json({ success: true, data: publicCitizen(c) });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

function publicCitizen(c) {
  return {
    id: c.id,
    full_name: c.full_name,
    email: c.email,
    phone: c.phone,
    department: c.department,
    commune: c.commune,
    points: c.points,
    role: c.role,
    email_verified: c.email_verified,
    phone_verified: c.phone_verified,
    profile_complete: c.profile_complete,
    created_at: c.created_at
  };
}

module.exports = router;
module.exports.publicCitizen = publicCitizen;
