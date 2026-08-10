const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { query } = require('../db/pool');
const { sign, protect } = require('../middleware/auth');
const { awardPoints } = require('../services/points');

const router = express.Router();

// OTP delivery is pluggable: until an SMS/email provider is connected, the code
// is returned in the response in non-production so the flow is fully testable.
const OTP_TTL_MIN = 10;
const EXPOSE_OTP = process.env.EXPOSE_OTP === 'true' || process.env.NODE_ENV !== 'production';

function makeOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function issueOtp(citizenId, channel, purpose = 'verify') {
  const code = makeOtp();
  await query(
    `INSERT INTO otp_codes (citizen_id, code, channel, purpose, expires_at)
     VALUES ($1,$2,$3,$4, NOW() + ($5 || ' minutes')::interval)`,
    [citizenId, code, channel, purpose, String(OTP_TTL_MIN)]
  );
  // TODO: wire SendGrid/Twilio here — the rest of the flow already works.
  return code;
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
      const code = await issueOtp(citizen.id, channel);

      await query(
        `INSERT INTO notifications (citizen_id, title, body)
         VALUES ($1,$2,$3)`,
        [citizen.id, 'Bienvenue sur STARFLEX',
         'Votre compte citoyen est créé. Vérifiez votre compte pour commencer votre parcours civique.']
      );

      res.status(201).json({
        success: true,
        message: `Code de vérification envoyé par ${channel === 'email' ? 'email' : 'SMS'}`,
        data: { citizen_id: citizen.id, channel, otp: EXPOSE_OTP ? code : undefined }
      });
    } catch (e) {
      console.error('register error', e.message);
      res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
  }
);

// POST /api/auth/verify-otp — confirm the code, activate the account, return a token
router.post('/verify-otp', async (req, res) => {
  try {
    const { citizen_id, code } = req.body;
    if (!citizen_id || !code) {
      return res.status(400).json({ success: false, message: 'Code requis' });
    }
    const { rows } = await query(
      `SELECT * FROM otp_codes
       WHERE citizen_id = $1 AND code = $2 AND consumed_at IS NULL AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [citizen_id, String(code).trim()]
    );
    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'Code invalide ou expiré' });
    }

    const otp = rows[0];
    await query('UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1', [otp.id]);

    const field = otp.channel === 'email' ? 'email_verified' : 'phone_verified';
    const updated = await query(
      `UPDATE citizens SET ${field} = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [citizen_id]
    );
    const citizen = updated.rows[0];

    // First verification is itself a civic step — start the points ledger.
    await awardPoints(citizen.id, 5, 'Compte vérifié', 'citizen', citizen.id);

    res.json({
      success: true,
      message: 'Compte vérifié',
      token: sign(citizen),
      data: publicCitizen(citizen)
    });
  } catch (e) {
    console.error('verify-otp error', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// POST /api/auth/resend-otp
router.post('/resend-otp', async (req, res) => {
  try {
    const { citizen_id } = req.body;
    const { rows } = await query('SELECT * FROM citizens WHERE id = $1', [citizen_id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Compte introuvable' });
    const channel = rows[0].email ? 'email' : 'sms';
    const code = await issueOtp(rows[0].id, channel);
    res.json({ success: true, message: 'Nouveau code envoyé', data: { otp: EXPOSE_OTP ? code : undefined } });
  } catch (e) {
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

    const { rows } = await query(
      'SELECT * FROM citizens WHERE email = $1 OR phone = $1',
      [identifier.toLowerCase()]
    );
    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'Identifiants incorrects' });
    }
    const citizen = rows[0];
    const ok = await bcrypt.compare(password, citizen.password_hash);
    if (!ok) return res.status(400).json({ success: false, message: 'Identifiants incorrects' });
    if (citizen.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Compte suspendu' });
    }

    // Unverified accounts must finish OTP before they get a session.
    if (!citizen.email_verified && !citizen.phone_verified) {
      const channel = citizen.email ? 'email' : 'sms';
      const code = await issueOtp(citizen.id, channel);
      return res.status(403).json({
        success: false,
        code: 'verification_required',
        message: 'Compte non vérifié — un nouveau code vient d\'être envoyé',
        data: { citizen_id: citizen.id, channel, otp: EXPOSE_OTP ? code : undefined }
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
