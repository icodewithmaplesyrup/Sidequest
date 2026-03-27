'use strict';
const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const db     = require('../db/pool');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');

const UPLOAD_DIR   = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
const MEDIA_BASE   = process.env.MEDIA_BASE_URL || 'http://localhost:3000/media';

// ─────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────

function xpForDifficulty(difficulty) {
  return { easy: 100, medium: 250, hard: 500, legend: 1000 }[difficulty] ?? 250;
}

function videoUrl(videoPath) {
  if (!videoPath) return null;
  return `${MEDIA_BASE}/videos/${path.basename(videoPath)}`;
}

// ── Shape a quest row for API responses ───────────────────
function formatQuest(row) {
  return {
    id:               row.id,
    title:            row.title,
    description:      row.description,
    difficulty:       row.difficulty,
    xp_base:          row.xp_base,
    xp_final:         row.xp_final,
    status:           row.status,
    latitude:         row.latitude,
    longitude:        row.longitude,
    location_name:    row.location_name,
    video_url:        videoUrl(row.video_path),
    has_dual_cam:     row.has_dual_cam,
    completion_count: row.completion_count,
    is_trailblazer:   row.is_trailblazer,
    submitted_at:     row.submitted_at,
    posted_at:        row.posted_at,
    author: row.author_username ? {
      id:           row.author_id,
      username:     row.author_username,
      display_name: row.author_display_name,
      pfp_url:      row.author_pfp_url,
    } : undefined,
  };
}

// ── Base SELECT with author join ──────────────────────────
const QUEST_SELECT = `
  SELECT
    q.*,
    u.username  AS author_username,
    u.display_name AS author_display_name,
    u.pfp_url   AS author_pfp_url
  FROM quests q
  JOIN users  u ON u.id = q.author_id
`;

// ─────────────────────────────────────────────────────────
//  GET /api/quests  — Feed (only posted quests)
// ─────────────────────────────────────────────────────────
router.get('/', optionalAuth, async (req, res) => {
  const { limit = 20, before } = req.query;
  const cap = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));

  try {
    let rows;
    if (before) {
      ({ rows } = await db.query(
        `${QUEST_SELECT}
         WHERE q.status = 'posted' AND q.posted_at < $1
         ORDER BY q.posted_at DESC
         LIMIT $2`,
        [before, cap]
      ));
    } else {
      ({ rows } = await db.query(
        `${QUEST_SELECT}
         WHERE q.status = 'posted'
         ORDER BY q.posted_at DESC
         LIMIT $1`,
        [cap]
      ));
    }
    return res.json({ quests: rows.map(formatQuest) });
  } catch (err) {
    console.error('[GET /quests]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────
//  GET /api/quests/map  — All posted quests with geo data
// ─────────────────────────────────────────────────────────
router.get('/map', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT q.id, q.title, q.xp_final, q.xp_base, q.difficulty,
              q.latitude, q.longitude, q.completion_count, q.is_trailblazer
       FROM quests q
       WHERE q.status = 'posted' AND q.latitude IS NOT NULL AND q.longitude IS NOT NULL
       ORDER BY q.completion_count DESC`
    );
    // Compact payload — client only needs these fields for pins
    return res.json({ quests: rows });
  } catch (err) {
    console.error('[GET /quests/map]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────
//  GET /api/quests/:id
// ─────────────────────────────────────────────────────────
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `${QUEST_SELECT} WHERE q.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Quest not found' });
    const quest = rows[0];
    // Non-mods can only see posted quests, or their own drafts/pending
    if (quest.status !== 'posted') {
      if (!req.user) return res.status(404).json({ error: 'Quest not found' });
      if (!req.user.is_mod && req.user.sub !== quest.author_id)
        return res.status(404).json({ error: 'Quest not found' });
    }
    return res.json(formatQuest(quest));
  } catch (err) {
    console.error('[GET /quests/:id]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────
//  POST /api/quests  — Submit a new quest (enters pipeline)
// ─────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const { title, description, difficulty, latitude, longitude, location_name } = req.body;

  if (!title?.trim())
    return res.status(400).json({ error: 'title is required' });
  if (!['easy','medium','hard','legend'].includes(difficulty))
    return res.status(400).json({ error: 'difficulty must be easy | medium | hard | legend' });

  const xp_base = xpForDifficulty(difficulty);

  try {
    const { rows } = await db.query(
      `INSERT INTO quests
         (author_id, title, description, difficulty, xp_base,
          status, latitude, longitude, location_name, geo_point)
       VALUES ($1,$2,$3,$4,$5,
               'pending_review',
               $6,$7,$8,
               CASE WHEN $6 IS NOT NULL AND $7 IS NOT NULL
                    THEN ST_SetSRID(ST_MakePoint($7,$6), 4326)
                    ELSE NULL END)
       RETURNING *`,
      [
        req.user.sub,
        title.trim(),
        (description || '').trim(),
        difficulty,
        xp_base,
        latitude  ?? null,
        longitude ?? null,
        location_name ?? null,
      ]
    );
    return res.status(201).json(formatQuest(rows[0]));
  } catch (err) {
    console.error('[POST /quests]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────
//  POST /api/quests/:id/video  — Attach video after recording
//  Transitions: pending_review → in_review (video now present)
// ─────────────────────────────────────────────────────────
router.post('/:id/video', requireAuth, upload.single('video'), async (req, res) => {
  const questId = req.params.id;

  // Verify ownership
  const { rows } = await db.query(
    'SELECT * FROM quests WHERE id=$1 AND author_id=$2',
    [questId, req.user.sub]
  );
  const quest = rows[0];

  if (!quest) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Quest not found or not yours' });
  }
  if (!['pending_review','draft'].includes(quest.status)) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(409).json({ error: `Cannot upload video on a quest with status: ${quest.status}` });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No video file attached (field name: video)' });
  }

  // If there was an old video, remove it
  if (quest.video_path) {
    const old = path.join(UPLOAD_DIR, 'videos', path.basename(quest.video_path));
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }

  // NOTE: For production you would run FFmpeg here to:
  //  1. Validate the video is not corrupt
  //  2. Generate a thumbnail
  //  3. Transcode to a consistent format/bitrate
  //  4. Extract duration
  // That pipeline is NOT implemented here — it requires FFmpeg to be installed
  // and a queue (Bull/BullMQ + Redis) for async processing.

  const relativePath = req.file.filename;

  const { rows: updated } = await db.query(
    `UPDATE quests SET video_path=$1, status='in_review' WHERE id=$2 RETURNING *`,
    [relativePath, questId]
  );

  return res.json({
    message: 'Video uploaded — quest is now in the review queue',
    quest:   formatQuest(updated[0]),
  });
});

// ─────────────────────────────────────────────────────────
//  POST /api/quests/:id/complete  — Record a user completing a quest
// ─────────────────────────────────────────────────────────
router.post('/:id/complete', requireAuth, upload.single('video'), async (req, res) => {
  const questId = req.params.id;
  const userId  = req.user.sub;

  try {
    const { rows: questRows } = await db.query(
      'SELECT * FROM quests WHERE id=$1 AND status=$2',
      [questId, 'posted']
    );
    if (!questRows.length)
      return res.status(404).json({ error: 'Quest not found or not available' });
    const quest = questRows[0];

    // Prevent completing your own quest
    if (quest.author_id === userId)
      return res.status(403).json({ error: 'You cannot complete your own quest' });

    const xpEarned = quest.xp_final ?? quest.xp_base;

    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO completions (quest_id, user_id, xp_earned, video_path)
         VALUES ($1,$2,$3,$4)`,
        [questId, userId, xpEarned, req.file?.filename ?? null]
      );
      await client.query(
        `INSERT INTO xp_transactions (user_id, delta, source, ref_id, note)
         VALUES ($1,$2,'completion',$3,'Quest completion')`,
        [userId, xpEarned, questId]
      );
      await client.query(
        'UPDATE users SET total_xp = total_xp + $1 WHERE id = $2',
        [xpEarned, userId]
      );
      // The royalty trigger on completions handles author XP automatically
    });

    return res.status(201).json({ xp_earned: xpEarned, message: `+${xpEarned} XP earned!` });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'You already completed this quest' });
    console.error('[POST /quests/:id/complete]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
