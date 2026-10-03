/* ════════════════════════════════════════════════════════════════════════
   STARFLEX CMS — the only thing Christopher's team can reach.
   Mounted at /api/cms.

   🔑 THE SECURITY POSITION, because this is a THIRD PARTY's login:
   - CMS accounts live in `cms_users`, NOT in `citizens`. Separate table.
   - CMS tokens are stamped `aud: 'starflex-cms'` and the CMS guard REFUSES
     any token without it, so a citizen's token cannot open this, and a CMS
     token cannot open the citizen API.
   - pool.js pins every connection to the `starflex` schema, so nothing here
     can read MsouWout, HaitiBiznis or MyPlopPlop even if it tried.
   - There is no route here that touches hosting, code or deployment.
   ════════════════════════════════════════════════════════════════════════ */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db/pool');

const router = express.Router();
const SECRET = process.env.JWT_SECRET || 'starflex-dev-secret';
const AUD = 'starflex-cms';

/* Images are posted as base64 JSON, so the parser needs room. The real limit
   is enforced on the DECODED bytes below — a generous parser with a strict
   check beats a tight parser that fails with a confusing error. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;        // 3 MB
router.use(express.json({ limit: '8mb' }));

function sign(u) {
  return jwt.sign({ id: u.id, role: u.role, aud: AUD }, SECRET, { expiresIn: '12h' });
}

async function cmsAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Connexion requise' });
    const p = jwt.verify(token, SECRET);
    /* ⛔ The whole point: a citizen token has no `aud`, so it stops here. */
    if (p.aud !== AUD) return res.status(401).json({ success: false, message: 'Jeton invalide' });
    const { rows } = await query(
      "SELECT id, email, name, role, status FROM cms_users WHERE id = $1 AND status = 'active'",
      [p.id]);
    if (!rows.length) return res.status(401).json({ success: false, message: 'Compte introuvable' });
    req.cms = rows[0];
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Session expirée' });
  }
}

/* Only an administrator may add or remove people. An editor works on content
   and nothing else — that is the whole difference between the two roles. */
function adminOnly(req, res, next) {
  if (!req.cms || req.cms.role !== 'admin') {
    return res.status(403).json({ success: false, message: "Réservé à l'administrateur" });
  }
  next();
}

/* ─── FIRST ACCOUNT ───────────────────────────────────────────────────────
   Guarded by the same SETUP_KEY as the migration, and it REFUSES once an
   administrator exists — so it cannot be used later to mint a second one.
   ⛔ I do not choose or keep anybody's password: it is supplied in the call
   and only its hash is stored. */
router.post('/bootstrap', async (req, res) => {
  try {
    const key = req.headers['x-setup-key'] || req.query.key;
    if (!process.env.SETUP_KEY || key !== process.env.SETUP_KEY) {
      return res.status(403).json({ success: false, message: 'Clé invalide' });
    }
    const existing = await query("SELECT COUNT(*)::int AS n FROM cms_users WHERE role = 'admin'");
    if (existing.rows[0].n > 0) {
      return res.status(409).json({ success: false, message: 'Un administrateur existe déjà' });
    }
    const { email, name, password } = req.body || {};
    if (!email || !password || String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Email et mot de passe (8 caractères minimum) requis' });
    }
    const hash = await bcrypt.hash(String(password), 10);
    const { rows } = await query(
      `INSERT INTO cms_users (email, name, role, pass_hash)
       VALUES (LOWER($1), $2, 'admin', $3) RETURNING id, email, name, role`,
      [String(email).trim(), name || null, hash]);
    res.json({ success: true, user: rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ─── SIGN IN ─────────────────────────────────────────────────────────── */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email et mot de passe requis' });
    }
    const { rows } = await query(
      "SELECT * FROM cms_users WHERE email = LOWER($1) AND status = 'active'", [String(email).trim()]);
    /* ⛔ One message for "no such email" and "wrong password" alike - telling
       an attacker which addresses exist is a gift. */
    const bad = { success: false, message: 'Email ou mot de passe incorrect' };
    if (!rows.length) { await bcrypt.compare('x', '$2a$10$' + 'x'.repeat(53)).catch(() => {}); return res.status(401).json(bad); }
    const u = rows[0];
    if (!(await bcrypt.compare(String(password), u.pass_hash))) return res.status(401).json(bad);
    await query('UPDATE cms_users SET last_login = NOW() WHERE id = $1', [u.id]);
    res.json({ success: true, token: sign(u),
               user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/me', cmsAuth, (req, res) => res.json({ success: true, user: req.cms }));

router.post('/change-password', cmsAuth, async (req, res) => {
  try {
    const { current, next } = req.body || {};
    if (!next || String(next).length < 8) {
      return res.status(400).json({ success: false, message: 'Nouveau mot de passe : 8 caractères minimum' });
    }
    const { rows } = await query('SELECT pass_hash FROM cms_users WHERE id = $1', [req.cms.id]);
    if (!(await bcrypt.compare(String(current || ''), rows[0].pass_hash))) {
      return res.status(401).json({ success: false, message: 'Mot de passe actuel incorrect' });
    }
    await query('UPDATE cms_users SET pass_hash = $1 WHERE id = $2',
                [await bcrypt.hash(String(next), 10), req.cms.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ─── WHO CAN GET IN (administrator only) ─────────────────────────────── */
router.get('/users', cmsAuth, adminOnly, async (req, res) => {
  const { rows } = await query(
    'SELECT id, email, name, role, status, created_at, last_login FROM cms_users ORDER BY created_at');
  res.json({ success: true, users: rows });
});

router.post('/users', cmsAuth, adminOnly, async (req, res) => {
  try {
    const { email, name, role, password } = req.body || {};
    if (!email || !password || String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Email et mot de passe (8 caractères minimum) requis' });
    }
    const r = (role === 'admin') ? 'admin' : 'editor';
    const { rows } = await query(
      `INSERT INTO cms_users (email, name, role, pass_hash) VALUES (LOWER($1), $2, $3, $4)
       RETURNING id, email, name, role, status`,
      [String(email).trim(), name || null, r, await bcrypt.hash(String(password), 10)]);
    res.json({ success: true, user: rows[0] });
  } catch (e) {
    if (String(e.message).includes('duplicate key')) {
      return res.status(409).json({ success: false, message: 'Cet email existe déjà' });
    }
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch('/users/:id', cmsAuth, adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, role, status, password } = req.body || {};
    /* ⛔ An administrator must not be able to lock the last door behind
       everybody - including by demoting or disabling himself. */
    if (id === req.cms.id && (role === 'editor' || status === 'disabled')) {
      return res.status(400).json({ success: false, message: 'Vous ne pouvez pas retirer votre propre accès' });
    }
    if (role === 'editor' || status === 'disabled') {
      const admins = await query(
        "SELECT COUNT(*)::int AS n FROM cms_users WHERE role = 'admin' AND status = 'active' AND id <> $1", [id]);
      if (admins.rows[0].n === 0) {
        return res.status(400).json({ success: false, message: 'Il doit rester au moins un administrateur actif' });
      }
    }
    const sets = [], vals = [];
    if (name !== undefined)   { vals.push(name);   sets.push('name = $' + vals.length); }
    if (role !== undefined)   { vals.push(role === 'admin' ? 'admin' : 'editor'); sets.push('role = $' + vals.length); }
    if (status !== undefined) { vals.push(status === 'disabled' ? 'disabled' : 'active'); sets.push('status = $' + vals.length); }
    if (password)             { vals.push(await bcrypt.hash(String(password), 10)); sets.push('pass_hash = $' + vals.length); }
    if (!sets.length) return res.status(400).json({ success: false, message: 'Rien à modifier' });
    vals.push(id);
    const { rows } = await query(
      'UPDATE cms_users SET ' + sets.join(', ') + ' WHERE id = $' + vals.length +
      ' RETURNING id, email, name, role, status', vals);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Introuvable' });
    res.json({ success: true, user: rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ─── PAGE TEXT ───────────────────────────────────────────────────────── */
router.get('/blocks', cmsAuth, async (req, res) => {
  const { rows } = await query('SELECT key, value, updated_at FROM content_blocks ORDER BY key');
  res.json({ success: true, blocks: rows });
});

router.put('/blocks/:key', cmsAuth, async (req, res) => {
  try {
    const key = String(req.params.key).slice(0, 120);
    const { rows } = await query(
      `INSERT INTO content_blocks (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
         updated_at = NOW(), updated_by = EXCLUDED.updated_by
       RETURNING key, value, updated_at`,
      [key, req.body && req.body.value, req.cms.id]);
    res.json({ success: true, block: rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

/* ─── NEWS AND EVENTS ─────────────────────────────────────────────────── */
router.get('/posts', cmsAuth, async (req, res) => {
  const { rows } = await query(
    `SELECT id, slug, kind, title, excerpt, body, starts_at, ends_at, location,
            image_id, published, created_at, updated_at
       FROM posts ORDER BY created_at DESC LIMIT 300`);
  res.json({ success: true, posts: rows });
});

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80) || 'article';
}

router.post('/posts', cmsAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ success: false, message: 'Un titre est requis' });
    /* A slug must be unique; add a short suffix rather than reject his work. */
    let slug = slugify(b.slug || b.title);
    const clash = await query('SELECT 1 FROM posts WHERE slug = $1', [slug]);
    if (clash.rows.length) slug = slug + '-' + Date.now().toString(36).slice(-4);
    const { rows } = await query(
      `INSERT INTO posts (slug, kind, title, excerpt, body, starts_at, ends_at,
                          location, image_id, published, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [slug, b.kind === 'event' ? 'event' : 'news', b.title, b.excerpt || null,
       b.body || null, b.starts_at || null, b.ends_at || null, b.location || null,
       b.image_id || null, b.published === true, req.cms.id]);
    res.json({ success: true, post: rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.patch('/posts/:id', cmsAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const allowed = ['kind', 'title', 'excerpt', 'body', 'starts_at', 'ends_at',
                     'location', 'image_id', 'published'];
    const sets = [], vals = [];
    allowed.forEach(function (k) {
      if (b[k] !== undefined) { vals.push(b[k]); sets.push(k + ' = $' + vals.length); }
    });
    if (!sets.length) return res.status(400).json({ success: false, message: 'Rien à modifier' });
    vals.push(req.cms.id); sets.push('updated_by = $' + vals.length);
    sets.push('updated_at = NOW()');
    vals.push(Number(req.params.id));
    const { rows } = await query(
      'UPDATE posts SET ' + sets.join(', ') + ' WHERE id = $' + vals.length + ' RETURNING *', vals);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Introuvable' });
    res.json({ success: true, post: rows[0] });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/posts/:id', cmsAuth, async (req, res) => {
  const { rowCount } = await query('DELETE FROM posts WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ success: false, message: 'Introuvable' });
  res.json({ success: true });
});

/* ─── PHOTOS ──────────────────────────────────────────────────────────── */
const OK_IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

router.post('/media', cmsAuth, async (req, res) => {
  try {
    const { filename, mime, data } = req.body || {};
    if (!data || !mime) return res.status(400).json({ success: false, message: 'Image manquante' });
    if (OK_IMAGE.indexOf(String(mime)) < 0) {
      return res.status(400).json({ success: false, message: 'Format accepté : JPG, PNG, WEBP ou GIF' });
    }
    const raw = String(data).replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(raw, 'base64');
    if (!buf.length) return res.status(400).json({ success: false, message: 'Image illisible' });
    if (buf.length > MAX_IMAGE_BYTES) {
      return res.status(413).json({ success: false,
        message: 'Image trop lourde (' + Math.round(buf.length / 1024) + ' Ko). Maximum 3 Mo.' });
    }
    const { rows } = await query(
      `INSERT INTO media (filename, mime, size_bytes, bytes, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, filename, mime, size_bytes, created_at`,
      [filename || null, mime, buf.length, buf, req.cms.id]);
    res.json({ success: true, media: rows[0], url: '/api/cms/media/' + rows[0].id });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/media', cmsAuth, async (req, res) => {
  const { rows } = await query(
    'SELECT id, filename, mime, size_bytes, created_at FROM media ORDER BY created_at DESC LIMIT 200');
  res.json({ success: true, media: rows });
});

/* Public on purpose: these are pictures on a public website. No listing, no
   metadata — you can only fetch an image you already have the id of. */
router.get('/media/:id', async (req, res) => {
  try {
    const { rows } = await query('SELECT mime, bytes FROM media WHERE id = $1', [Number(req.params.id)]);
    if (!rows.length) return res.status(404).end();
    res.set('Content-Type', rows[0].mime);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(rows[0].bytes);
  } catch (e) { res.status(404).end(); }
});

router.delete('/media/:id', cmsAuth, adminOnly, async (req, res) => {
  const { rowCount } = await query('DELETE FROM media WHERE id = $1', [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ success: false, message: 'Introuvable' });
  res.json({ success: true });
});

/* ─── WHAT THE PUBLIC SITE READS ──────────────────────────────────────── */
router.get('/public/content', async (req, res) => {
  try {
    const blocks = await query('SELECT key, value FROM content_blocks');
    const posts = await query(
      `SELECT id, slug, kind, title, excerpt, body, starts_at, ends_at, location,
              image_id, created_at
         FROM posts WHERE published = TRUE ORDER BY COALESCE(starts_at, created_at) DESC LIMIT 60`);
    const map = {};
    blocks.rows.forEach(function (b) { map[b.key] = b.value; });
    res.json({ success: true, blocks: map, posts: posts.rows });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
