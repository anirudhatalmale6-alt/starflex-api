const { query } = require('../db/pool');

// Certificate levels are derived from the points ledger, so a citizen's
// certificate always reflects what they actually did.
const LEVELS = [
  { level: 'or',     min: 150 },
  { level: 'argent', min: 75 },
  { level: 'bronze', min: 30 }
];

function levelFor(points) {
  const hit = LEVELS.find((l) => points >= l.min);
  return hit ? hit.level : null;
}

// Award points, write the audit trail, and (re)issue the certificate when earned.
async function awardPoints(citizenId, points, reason, refType, refId) {
  await query(
    'INSERT INTO point_events (citizen_id, points, reason, ref_type, ref_id) VALUES ($1,$2,$3,$4,$5)',
    [citizenId, points, reason, refType || null, refId || null]
  );
  const { rows } = await query(
    'UPDATE citizens SET points = points + $1, updated_at = NOW() WHERE id = $2 RETURNING points',
    [points, citizenId]
  );
  const total = rows[0] ? rows[0].points : 0;
  await syncCertificate(citizenId, total);
  return total;
}

// Issue the Certificat National de Participation Citoyenne, or upgrade its level.
async function syncCertificate(citizenId, totalPoints) {
  const level = levelFor(totalPoints);
  if (!level) return null;

  const existing = await query('SELECT * FROM certificates WHERE citizen_id = $1', [citizenId]);
  if (!existing.rows.length) {
    const code = 'SF-' + String(citizenId).padStart(5, '0') + '-' +
      Math.random().toString(36).slice(2, 7).toUpperCase();
    const { rows } = await query(
      `INSERT INTO certificates (citizen_id, code, level, points_at_issue)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [citizenId, code, level, totalPoints]
    );
    await query(
      'INSERT INTO notifications (citizen_id, title, body) VALUES ($1,$2,$3)',
      [citizenId, 'Certificat obtenu !',
       'Félicitations — vous avez obtenu votre Certificat National de Participation Citoyenne (niveau ' + level + ').']
    );
    return rows[0];
  }

  const cert = existing.rows[0];
  const order = { bronze: 1, argent: 2, or: 3 };
  if (order[level] > order[cert.level]) {
    const { rows } = await query(
      'UPDATE certificates SET level = $1, points_at_issue = $2 WHERE id = $3 RETURNING *',
      [level, totalPoints, cert.id]
    );
    await query(
      'INSERT INTO notifications (citizen_id, title, body) VALUES ($1,$2,$3)',
      [citizenId, 'Certificat mis à niveau', 'Votre certificat est passé au niveau ' + level + '.']
    );
    return rows[0];
  }
  return cert;
}

module.exports = { awardPoints, syncCertificate, levelFor, LEVELS };
