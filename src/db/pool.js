const { Pool } = require('pg');

// Render's managed Postgres requires SSL; local dev usually doesn't.
const useSSL = /render\.com|amazonaws\.com/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: 8,
  idleTimeoutMillis: 30000
});

// Every connection works inside the starflex schema.
pool.on('connect', (client) => {
  client.query('SET search_path TO starflex, public').catch(() => {});
});

module.exports = { pool, query: (t, p) => pool.query(t, p) };
