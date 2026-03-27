'use strict';
require('dotenv').config();

const express      = require('express');
const path         = require('path');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');

const app = express();

// ── Security ──────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ── Logging ───────────────────────────────────────────────
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Body parsing ─────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Rate limiting ─────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max: 20,
  message: { error: 'Too many auth attempts — try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 min
  max: 120,
  message: { error: 'Rate limit exceeded' },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);

// ── Static media (uploaded videos/thumbnails) ─────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
app.use('/media', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  // Security: don't serve directory listings
  index: false,
}));

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth',   require('./routes/auth'));
app.use('/api/quests', require('./routes/quests'));
app.use('/api/review', require('./routes/review'));
app.use('/api/users',  require('./routes/users'));

// ── Health check ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── 404 ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ─────────────────────────────────────────
app.use((err, req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(413).json({ error: `Video too large (max ${process.env.MAX_VIDEO_SIZE_MB || 100} MB)` });
  console.error('[server error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sidequest API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = app;
