'use strict';
const router = require('express').Router();
const db     = require('../db/pool');
const { requireAuth, optionalAuth } = require('../middleware/auth');

// ── Level calculation (mirrors client-side logic) ─────────
function calcLevel(xp) {
  let lvl = 1, gap = 100, threshold = 100;
  while (xp >= threshold) {
    lvl++;
    gap = Math.floor(gap * 1.5);
    threshold += gap;
  }
  const titles = ['Novice','Initiate','Adventurer','Explorer','Trailblazer',
                   'Knight','Shadow Knight','Legend','Mythic','Immortal'];
  return { level: lvl, title: titles[Math.min(lvl - 1, titles.length - 1)] };
}

// ── GET /api/users/me ────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE id=$1', [req.user.sub]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    const { level, title } = calcLevel(u.total_xp);

    // Royalty XP earned today
    const { rows: royaltyRows } = await db.query(
      `SELECT COALESCE(SUM(delta),0) AS royalty
       FROM xp_transactions
       WHERE user_id=$1 AND source='royalty' AND created_at >= CURRENT_DATE`,
      [u.id]
    );

    return res.json({
      id:           u.id,
      username:     u.username,
      display_name: u.display_name,
      bio:          u.bio,
      pfp_url:      u.pfp_url,
      total_xp:     u.total_xp,
      royalty_xp_today: parseInt(royaltyRows[0].royalty, 10),
      level,
      title,
      is_mod:       u.is_mod,
      equipped:     { ring: u.equipped_ring, background: u.equipped_background },
    });
  } catch (err) {
    console.error('[GET /users/me]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/users/me ──────────────────────────────────
router.patch('/me', requireAuth, async (req, res) => {
  const { username, display_name, bio, equipped_ring, equipped_background } = req.body;

  const allowed = {};
  if (username !== undefined) {
    if (!/^[a-z0-9_]{2,24}$/.test(username))
      return res.status(400).json({ error: 'Username must be 2–24 lowercase letters, numbers or underscores' });
    allowed.username = username;
  }
  if (display_name !== undefined) allowed.display_name = display_name.slice(0, 40);
  if (bio          !== undefined) allowed.bio          = bio.slice(0, 160);
  if (equipped_ring        !== undefined) allowed.equipped_ring        = equipped_ring || null;
  if (equipped_background  !== undefined) allowed.equipped_background  = equipped_background || null;

  if (!Object.keys(allowed).length)
    return res.status(400).json({ error: 'No valid fields to update' });

  const setClauses = Object.keys(allowed).map((k, i) => `${k}=$${i + 1}`).join(', ');
  const values     = [...Object.values(allowed), req.user.sub];

  try {
    const { rows } = await db.query(
      `UPDATE users SET ${setClauses} WHERE id=$${values.length} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    return res.json({ username: rows[0].username, display_name: rows[0].display_name });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'Username already taken' });
    console.error('[PATCH /users/me]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/users/me/quests ─────────────────────────────
router.get('/me/quests', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, title, status, xp_base, xp_final, difficulty,
              completion_count, submitted_at, posted_at
       FROM quests WHERE author_id=$1
       ORDER BY submitted_at DESC LIMIT 50`,
      [req.user.sub]
    );
    return res.json({ quests: rows });
  } catch (err) {
    console.error('[GET /users/me/quests]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/users/me/completions ────────────────────────
router.get('/me/completions', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.xp_earned, c.completed_at,
              q.id AS quest_id, q.title, q.location_name
       FROM completions c
       JOIN quests q ON q.id = c.quest_id
       WHERE c.user_id=$1
       ORDER BY c.completed_at DESC LIMIT 50`,
      [req.user.sub]
    );
    return res.json({ completions: rows });
  } catch (err) {
    console.error('[GET /users/me/completions]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/users/leaderboard ───────────────────────────
router.get('/leaderboard', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, username, display_name, pfp_url, total_xp,
              ROW_NUMBER() OVER (ORDER BY total_xp DESC) AS rank
       FROM users
       ORDER BY total_xp DESC LIMIT 100`
    );
    return res.json({ leaderboard: rows });
  } catch (err) {
    console.error('[GET /users/leaderboard]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/users/:username ─────────────────────────────
router.get('/:username', optionalAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, username, display_name, bio, pfp_url, total_xp, equipped_ring, equipped_background FROM users WHERE username=$1',
      [req.params.username]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    const { level, title } = calcLevel(u.total_xp);
    return res.json({ ...u, level, title });
  } catch (err) {
    console.error('[GET /users/:username]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
