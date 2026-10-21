/* 🔒 21 Oct 2026 — wrong-password limiter for the two sign-in doors (citizen
   and CMS). Before this, both answered as fast as anyone could ask, so a
   password could simply be guessed.

   Counts FAILED attempts only, per identifier and per IP, in memory (one
   Render instance). A success clears the identifier's count. */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_ID = 8;      // wrong passwords for one account in 15 min
const MAX_PER_IP = 30;     // wrong passwords from one address in 15 min

const hits = new Map();    // key -> [timestamps]

function recent(key, now) {
  const list = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) hits.set(key, list); else hits.delete(key);
  return list;
}

/* req.ip with `trust proxy = 1`: the address Render's proxy saw. NOT the first
   X-Forwarded-For entry — the visitor can write that one themselves. */
function clientIp(req) {
  return req.ip || 'unknown';
}

/* Call before checking the password. Returns false (and answers 429) when blocked. */
function allow(req, res, door, identifier) {
  const now = Date.now();
  const id = door + ':id:' + String(identifier || '').trim().toLowerCase();
  const ip = door + ':ip:' + clientIp(req);
  if (recent(id, now).length >= MAX_PER_ID || recent(ip, now).length >= MAX_PER_IP) {
    res.status(429).json({ success: false, code: 'too_many_attempts',
      message: 'Trop de tentatives — réessayez dans 15 minutes' });
    return false;
  }
  return true;
}

function fail(req, door, identifier) {
  const now = Date.now();
  [door + ':id:' + String(identifier || '').trim().toLowerCase(), door + ':ip:' + clientIp(req)]
    .forEach((k) => { const l = recent(k, now); l.push(now); hits.set(k, l); });
}

function succeed(door, identifier) {
  hits.delete(door + ':id:' + String(identifier || '').trim().toLowerCase());
}

module.exports = { allow, fail, succeed };
