const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');

const SECRET = process.env.JWT_SECRET || 'starflex-dev-secret';

function sign(citizen) {
  return jwt.sign({ id: citizen.id, role: citizen.role }, SECRET, { expiresIn: '30d' });
}

async function protect(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Authentification requise' });

    const payload = jwt.verify(token, SECRET);

    /* 🚨 A CMS token must NEVER open the citizen API. Both are signed with the
       same secret, and the lookup below is by NUMERIC id — so CMS user #1 was
       being matched against citizen #1 and let straight in. A test caught it;
       nothing in the code said it was wrong.
       CMS tokens carry aud = 'starflex-cms'. A citizen token has no aud at all,
       so this refuses the one and passes the other. */
    if (payload.aud) {
      return res.status(401).json({ success: false, message: 'Jeton invalide' });
    }

    const { rows } = await query('SELECT * FROM citizens WHERE id = $1 AND status = $2', [payload.id, 'active']);
    if (!rows.length) return res.status(401).json({ success: false, message: 'Compte introuvable' });

    req.citizen = rows[0];
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Session expirée' });
  }
}

function adminOnly(req, res, next) {
  if (!req.citizen || req.citizen.role !== 'admin') {
    return res.status(403).json({ success: false, message: "Accès réservé à l'administration" });
  }
  next();
}

module.exports = { sign, protect, adminOnly, SECRET };
