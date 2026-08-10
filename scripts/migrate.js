// Applies the schema and seeds starter civic content. Safe to re-run.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, query } = require('../src/db/pool');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('schema applied');

  const { rows } = await query('SELECT COUNT(*)::int AS n FROM modules');
  if (rows[0].n === 0) {
    await query(`INSERT INTO modules (slug,title,summary,duration_min,points,sort_order) VALUES
      ('institutions','Les institutions de la République','Comprendre le rôle du Parlement, de l''Exécutif et de la Justice.',12,10,1),
      ('processus-electoral','Le processus électoral','Comment se déroule une élection et comment y participer.',15,10,2),
      ('droits-devoirs','Droits et devoirs du citoyen','Vos droits fondamentaux et vos responsabilités civiques.',10,10,3),
      ('participation-locale','La participation locale','Agir dans sa commune : conseils, budgets et projets locaux.',12,10,4)`);
    console.log('seeded modules');
  }

  const cons = await query('SELECT COUNT(*)::int AS n FROM consultations');
  if (cons.rows[0].n === 0) {
    await query(`INSERT INTO consultations (slug,title,description,kind,options,points) VALUES
      ('priorite-communale','Quelle est la priorité de votre commune ?','Aidez les institutions à comprendre les besoins prioritaires de votre communauté.','survey',
       '[{"key":"eau","label":"Accès à l''eau potable"},{"key":"education","label":"Éducation"},{"key":"sante","label":"Santé"},{"key":"routes","label":"Routes et transport"},{"key":"securite","label":"Sécurité"}]'::jsonb, 5),
      ('participation-jeunes','Comment encourager la participation des jeunes ?','Consultation publique ouverte sur l''engagement civique des jeunes.','consultation', NULL, 15)`);
    console.log('seeded consultations');
  }

  const vol = await query('SELECT COUNT(*)::int AS n FROM volunteer_opportunities');
  if (vol.rows[0].n === 0) {
    await query(`INSERT INTO volunteer_opportunities (title,description,location,points) VALUES
      ('Sensibilisation électorale','Aider à informer les citoyens sur le processus électoral dans votre commune.','Port-au-Prince',25),
      ('Appui aux aînés','Accompagner les personnes âgées dans leurs démarches civiques.','Toutes communes',25)`);
    console.log('seeded volunteer opportunities');
  }

  await pool.end();
  console.log('migration complete');
}

main().catch((e) => { console.error('migration failed:', e.message); process.exit(1); });
