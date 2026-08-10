require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
app.use(helmet());
app.use(cors());                       // public platform; tighten to domains at launch
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

app.get('/api/health', async (req, res) => {
  let db = false;
  try {
    const { query } = require('./db/pool');
    await query('SELECT 1');
    db = true;
  } catch (e) { /* reported below */ }
  res.json({ status: 'ok', service: 'STARFLEX API', version: '1.0.0', db });
});


// One-time schema setup/seed, guarded by a secret. Lets us migrate a managed
// database we cannot reach directly from a shell. Safe to call repeatedly.
app.post('/api/admin/migrate', async (req, res) => {
  const key = req.headers['x-setup-key'] || req.query.key;
  if (!process.env.SETUP_KEY || key !== process.env.SETUP_KEY) {
    return res.status(403).json({ success: false, message: 'Clé invalide' });
  }
  try {
    const fs = require('fs');
    const path = require('path');
    const { pool, query } = require('./db/pool');
    await pool.query(fs.readFileSync(path.join(__dirname, 'db/schema.sql'), 'utf8'));

    const seeded = {};
    const m = await query('SELECT COUNT(*)::int AS n FROM modules');
    if (m.rows[0].n === 0) {
      await query(`INSERT INTO modules (slug,title,summary,duration_min,points,sort_order) VALUES
        ('institutions','Les institutions de la République','Comprendre le rôle du Parlement, de l''Exécutif et de la Justice.',12,10,1),
        ('processus-electoral','Le processus électoral','Comment se déroule une élection et comment y participer.',15,10,2),
        ('droits-devoirs','Droits et devoirs du citoyen','Vos droits fondamentaux et vos responsabilités civiques.',10,10,3),
        ('participation-locale','La participation locale','Agir dans sa commune : conseils, budgets et projets locaux.',12,10,4)`);
      seeded.modules = 4;
    }
    const c = await query('SELECT COUNT(*)::int AS n FROM consultations');
    if (c.rows[0].n === 0) {
      await query(`INSERT INTO consultations (slug,title,description,kind,options,points) VALUES
        ('priorite-communale','Quelle est la priorité de votre commune ?','Aidez les institutions à comprendre les besoins prioritaires de votre communauté.','survey',
         '[{"key":"eau","label":"Accès à l''eau potable"},{"key":"education","label":"Éducation"},{"key":"sante","label":"Santé"},{"key":"routes","label":"Routes et transport"},{"key":"securite","label":"Sécurité"}]'::jsonb, 5),
        ('participation-jeunes','Comment encourager la participation des jeunes ?','Consultation publique ouverte sur l''engagement civique des jeunes.','consultation', NULL, 15)`);
      seeded.consultations = 2;
    }
    const v = await query('SELECT COUNT(*)::int AS n FROM volunteer_opportunities');
    if (v.rows[0].n === 0) {
      await query(`INSERT INTO volunteer_opportunities (title,description,location,points) VALUES
        ('Sensibilisation électorale','Aider à informer les citoyens sur le processus électoral dans votre commune.','Port-au-Prince',25),
        ('Appui aux aînés','Accompagner les personnes âgées dans leurs démarches civiques.','Toutes communes',25)`);
      seeded.volunteer = 2;
    }
    res.json({ success: true, message: 'Schéma appliqué', seeded });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/civic', require('./routes/civic'));

app.use((req, res) => res.status(404).json({ success: false, message: 'Route introuvable' }));

const PORT = process.env.PORT || 5100;
app.listen(PORT, () => console.log('STARFLEX API on ' + PORT));

module.exports = app;
