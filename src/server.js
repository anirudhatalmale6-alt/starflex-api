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

app.use('/api/auth', require('./routes/auth'));
app.use('/api/civic', require('./routes/civic'));

app.use((req, res) => res.status(404).json({ success: false, message: 'Route introuvable' }));

const PORT = process.env.PORT || 5100;
app.listen(PORT, () => console.log('STARFLEX API on ' + PORT));

module.exports = app;
