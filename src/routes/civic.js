const express = require('express');
const { query } = require('../db/pool');
const { protect } = require('../middleware/auth');
const { awardPoints } = require('../services/points');

const router = express.Router();

// ── Civic education ─────────────────────────────────────────────────────────

// GET /api/civic/modules — list modules, flagged with what this citizen finished
router.get('/modules', protect, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT m.*, (mc.id IS NOT NULL) AS completed
         FROM modules m
    LEFT JOIN module_completions mc
           ON mc.module_id = m.id AND mc.citizen_id = $1
        WHERE m.published
     ORDER BY m.sort_order, m.id`,
      [req.citizen.id]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// POST /api/civic/modules/:id/complete
router.post('/modules/:id/complete', protect, async (req, res) => {
  try {
    const mod = await query('SELECT * FROM modules WHERE id = $1 AND published', [req.params.id]);
    if (!mod.rows.length) return res.status(404).json({ success: false, message: 'Module introuvable' });

    const already = await query(
      'SELECT id FROM module_completions WHERE citizen_id = $1 AND module_id = $2',
      [req.citizen.id, req.params.id]
    );
    if (already.rows.length) {
      return res.json({ success: true, message: 'Module déjà terminé', data: { points_awarded: 0 } });
    }

    await query(
      'INSERT INTO module_completions (citizen_id, module_id) VALUES ($1,$2)',
      [req.citizen.id, req.params.id]
    );
    const total = await awardPoints(
      req.citizen.id, mod.rows[0].points, 'Module terminé : ' + mod.rows[0].title, 'module', mod.rows[0].id
    );

    res.json({ success: true, message: 'Module terminé', data: { points_awarded: mod.rows[0].points, total_points: total } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// ── Consultations & surveys ─────────────────────────────────────────────────

router.get('/consultations', protect, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT c.*, (r.id IS NOT NULL) AS answered
         FROM consultations c
    LEFT JOIN consultation_responses r
           ON r.consultation_id = c.id AND r.citizen_id = $1
        WHERE c.published
          AND (c.opens_at  IS NULL OR c.opens_at  <= NOW())
          AND (c.closes_at IS NULL OR c.closes_at >= NOW())
     ORDER BY c.created_at DESC`,
      [req.citizen.id]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/consultations/:id/respond', protect, async (req, res) => {
  try {
    const c = await query('SELECT * FROM consultations WHERE id = $1 AND published', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ success: false, message: 'Consultation introuvable' });

    const dupe = await query(
      'SELECT id FROM consultation_responses WHERE consultation_id = $1 AND citizen_id = $2',
      [req.params.id, req.citizen.id]
    );
    if (dupe.rows.length) {
      return res.status(400).json({ success: false, message: 'Vous avez déjà participé' });
    }

    await query(
      'INSERT INTO consultation_responses (consultation_id, citizen_id, choice, comment) VALUES ($1,$2,$3,$4)',
      [req.params.id, req.citizen.id, req.body.choice || null, req.body.comment || null]
    );
    const total = await awardPoints(
      req.citizen.id, c.rows[0].points, 'Participation : ' + c.rows[0].title, 'consultation', c.rows[0].id
    );

    res.json({ success: true, message: 'Merci pour votre participation', data: { points_awarded: c.rows[0].points, total_points: total } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Aggregated results — transparency for citizens, input for institutions.
router.get('/consultations/:id/results', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT choice, COUNT(*)::int AS votes
         FROM consultation_responses
        WHERE consultation_id = $1 AND choice IS NOT NULL
     GROUP BY choice ORDER BY votes DESC`,
      [req.params.id]
    );
    const total = rows.reduce((s, r) => s + r.votes, 0);
    res.json({ success: true, data: { total, results: rows } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// ── Volunteering ────────────────────────────────────────────────────────────

router.get('/volunteer', protect, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT v.*, (s.id IS NOT NULL) AS signed_up
         FROM volunteer_opportunities v
    LEFT JOIN volunteer_signups s
           ON s.opportunity_id = v.id AND s.citizen_id = $1
        WHERE v.published
     ORDER BY v.starts_at NULLS LAST, v.id`,
      [req.citizen.id]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.post('/volunteer/:id/signup', protect, async (req, res) => {
  try {
    const v = await query('SELECT * FROM volunteer_opportunities WHERE id = $1 AND published', [req.params.id]);
    if (!v.rows.length) return res.status(404).json({ success: false, message: 'Opportunité introuvable' });

    const dupe = await query(
      'SELECT id FROM volunteer_signups WHERE opportunity_id = $1 AND citizen_id = $2',
      [req.params.id, req.citizen.id]
    );
    if (dupe.rows.length) return res.status(400).json({ success: false, message: 'Déjà inscrit' });

    await query(
      'INSERT INTO volunteer_signups (opportunity_id, citizen_id) VALUES ($1,$2)',
      [req.params.id, req.citizen.id]
    );
    const total = await awardPoints(
      req.citizen.id, v.rows[0].points, 'Volontariat : ' + v.rows[0].title, 'volunteer', v.rows[0].id
    );

    res.json({ success: true, message: 'Inscription enregistrée', data: { points_awarded: v.rows[0].points, total_points: total } });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// ── Dashboard / notifications / certificate ─────────────────────────────────

router.get('/dashboard', protect, async (req, res) => {
  try {
    const id = req.citizen.id;
    const [modules, consults, volunteer, unread, cert, recent] = await Promise.all([
      query('SELECT COUNT(*)::int AS n FROM module_completions WHERE citizen_id = $1', [id]),
      query('SELECT COUNT(*)::int AS n FROM consultation_responses WHERE citizen_id = $1', [id]),
      query('SELECT COUNT(*)::int AS n FROM volunteer_signups WHERE citizen_id = $1', [id]),
      query('SELECT COUNT(*)::int AS n FROM notifications WHERE (citizen_id = $1 OR citizen_id IS NULL) AND read_at IS NULL', [id]),
      query('SELECT * FROM certificates WHERE citizen_id = $1', [id]),
      query('SELECT points, reason, created_at FROM point_events WHERE citizen_id = $1 ORDER BY created_at DESC LIMIT 8', [id])
    ]);

    res.json({
      success: true,
      data: {
        points: req.citizen.points,
        modules_completed: modules.rows[0].n,
        consultations_answered: consults.rows[0].n,
        volunteer_signups: volunteer.rows[0].n,
        unread_notifications: unread.rows[0].n,
        certificate: cert.rows[0] || null,
        recent_activity: recent.rows
      }
    });
  } catch (e) {
    console.error('dashboard error', e.message);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.get('/notifications', protect, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM notifications
        WHERE citizen_id = $1 OR citizen_id IS NULL
     ORDER BY created_at DESC LIMIT 50`,
      [req.citizen.id]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.put('/notifications/read', protect, async (req, res) => {
  try {
    await query(
      'UPDATE notifications SET read_at = NOW() WHERE citizen_id = $1 AND read_at IS NULL',
      [req.citizen.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Public certificate verification — anyone can check a certificate code.
router.get('/certificate/verify/:code', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT c.code, c.level, c.issued_at, c.revoked_at, ci.full_name, ci.department
         FROM certificates c JOIN citizens ci ON ci.id = c.citizen_id
        WHERE c.code = $1`,
      [req.params.code]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Certificat introuvable' });
    const c = rows[0];
    res.json({
      success: true,
      data: {
        valid: !c.revoked_at,
        code: c.code,
        level: c.level,
        issued_at: c.issued_at,
        holder: c.full_name,
        department: c.department
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Public content for the website (news + events)
router.get('/posts', async (req, res) => {
  try {
    const kind = req.query.kind;
    const { rows } = kind
      ? await query('SELECT * FROM posts WHERE published AND kind = $1 ORDER BY created_at DESC LIMIT 20', [kind])
      : await query('SELECT * FROM posts WHERE published ORDER BY created_at DESC LIMIT 20');
    res.json({ success: true, data: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

module.exports = router;
