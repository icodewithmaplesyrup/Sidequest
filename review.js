'use strict';
const router  = require('express').Router();
const db      = require('../db/pool');
const { requireMod, requireAuth } = require('../middleware/auth');

const MIN_VOTES    = parseInt(process.env.MIN_VOTES_FOR_DECISION || '5', 10);
const REVIEWER_XP  = parseInt(process.env.REVIEWER_XP_REWARD    || '15', 10);

// ─────────────────────────────────────────────────────────
//  Decision engine
//  Called after every new vote.  When MIN_VOTES is reached:
//    - majority 'rejected'  → status = 'rejected'
//    - majority 'more_xp'   → bump xp_final, status = 'posted'
//    - majority 'approved'  → status = 'posted' (xp_final = xp_base)
// ─────────────────────────────────────────────────────────
async function evaluateQuest(client, questId) {
  const { rows: voteRows } = await client.query(
    `SELECT vote, xp_suggest, COUNT(*) AS count
     FROM review_votes WHERE quest_id=$1
     GROUP BY vote, xp_suggest`,
    [questId]
  );

  const tally = { approved: 0, more_xp: 0, rejected: 0 };
  const xpSuggestions = [];
  let totalVotes = 0;

  for (const r of voteRows) {
    const n = parseInt(r.count, 10);
    tally[r.vote] = (tally[r.vote] || 0) + n;
    totalVotes += n;
    if (r.vote === 'more_xp' && r.xp_suggest) {
      for (let i = 0; i < n; i++) xpSuggestions.push(parseInt(r.xp_suggest, 10));
    }
  }

  if (totalVotes < MIN_VOTES) return;  // not enough data yet

  const { rows: questRows } = await client.query(
    'SELECT xp_base FROM quests WHERE id=$1', [questId]
  );
  const xpBase = questRows[0]?.xp_base ?? 250;

  if (tally.rejected > totalVotes / 2) {
    await client.query(
      `UPDATE quests SET status='rejected', reviewed_at=now() WHERE id=$1`,
      [questId]
    );
    return;
  }

  // Approved or more_xp — post it
  let xpFinal = xpBase;
  if (tally.more_xp > tally.approved && xpSuggestions.length) {
    const avg = xpSuggestions.reduce((a, b) => a + b, 0) / xpSuggestions.length;
    // Round to nearest valid tier
    const tiers = [100, 250, 500, 1000];
    xpFinal = tiers.reduce((prev, curr) =>
      Math.abs(curr - avg) < Math.abs(prev - avg) ? curr : prev
    );
  }

  await client.query(
    `UPDATE quests
       SET status='posted', xp_final=$1, reviewed_at=now(), posted_at=now()
     WHERE id=$2`,
    [xpFinal, questId]
  );
}

// ─────────────────────────────────────────────────────────
//  GET /api/review/queue  — Quests needing votes (mods only)
// ─────────────────────────────────────────────────────────
router.get('/queue', requireMod, async (req, res) => {
  const { limit = 20 } = req.query;
  const cap = Math.min(50, parseInt(limit, 10) || 20);

  try {
    // Return quests in_review that THIS mod hasn't voted on yet
    const { rows } = await db.query(
      `SELECT
         q.id, q.title, q.description, q.difficulty, q.xp_base,
         q.location_name, q.latitude, q.longitude,
         q.video_path, q.has_dual_cam, q.submitted_at,
         u.username AS author_username,
         u.pfp_url  AS author_pfp_url,
         (SELECT COUNT(*) FROM review_votes rv WHERE rv.quest_id = q.id) AS vote_count
       FROM quests q
       JOIN users  u ON u.id = q.author_id
       WHERE q.status = 'in_review'
         AND NOT EXISTS (
           SELECT 1 FROM review_votes rv
           WHERE rv.quest_id = q.id AND rv.voter_id = $1
         )
       ORDER BY q.submitted_at ASC
       LIMIT $2`,
      [req.user.sub, cap]
    );

    const MEDIA_BASE = process.env.MEDIA_BASE_URL || 'http://localhost:3000/media';
    const formatted = rows.map(r => ({
      ...r,
      vote_count: parseInt(r.vote_count, 10),
      video_url: r.video_path ? `${MEDIA_BASE}/videos/${r.video_path}` : null,
    }));

    return res.json({ queue: formatted, min_votes: MIN_VOTES });
  } catch (err) {
    console.error('[GET /review/queue]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────
//  POST /api/review/:questId/vote
//  Body: { vote: 'approved'|'more_xp'|'rejected', xp_suggest?: number }
// ─────────────────────────────────────────────────────────
router.post('/:questId/vote', requireMod, async (req, res) => {
  const { questId } = req.params;
  const { vote, xp_suggest } = req.body;
  const voterId = req.user.sub;

  if (!['approved','more_xp','rejected'].includes(vote))
    return res.status(400).json({ error: 'vote must be approved | more_xp | rejected' });
  if (vote === 'more_xp' && !xp_suggest)
    return res.status(400).json({ error: 'xp_suggest is required when vote is more_xp' });

  try {
    const { rows: questRows } = await db.query(
      'SELECT status FROM quests WHERE id=$1', [questId]
    );
    if (!questRows.length)
      return res.status(404).json({ error: 'Quest not found' });
    if (questRows[0].status !== 'in_review')
      return res.status(409).json({ error: `Quest is not in review (status: ${questRows[0].status})` });

    await db.transaction(async (client) => {
      // Insert the vote
      await client.query(
        `INSERT INTO review_votes (quest_id, voter_id, vote, xp_suggest)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (quest_id, voter_id) DO UPDATE
           SET vote=$3, xp_suggest=$4`,
        [questId, voterId, vote, xp_suggest ?? null]
      );

      // Award reviewer XP
      await client.query(
        `INSERT INTO xp_transactions (user_id, delta, source, ref_id, note)
         VALUES ($1,$2,'review_vote',$3,'Review vote')`,
        [voterId, REVIEWER_XP, questId]
      );
      await client.query(
        'UPDATE users SET total_xp = total_xp + $1 WHERE id = $2',
        [REVIEWER_XP, voterId]
      );

      // Evaluate whether we now have a decision
      await evaluateQuest(client, questId);
    });

    // Fetch current quest status to return to client
    const { rows: updated } = await db.query(
      'SELECT status, xp_final FROM quests WHERE id=$1', [questId]
    );
    return res.json({
      xp_earned:    REVIEWER_XP,
      quest_status: updated[0].status,
      xp_final:     updated[0].xp_final,
    });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'You already voted on this quest' });
    console.error('[POST /review/:id/vote]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────
//  GET /api/review/stats  — Aggregate review stats for a mod
// ─────────────────────────────────────────────────────────
router.get('/stats', requireMod, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT vote, COUNT(*) AS count
       FROM review_votes WHERE voter_id=$1
       GROUP BY vote`,
      [req.user.sub]
    );
    const stats = { approved: 0, more_xp: 0, rejected: 0, total: 0 };
    for (const r of rows) {
      stats[r.vote] = parseInt(r.count, 10);
      stats.total  += parseInt(r.count, 10);
    }
    stats.xp_earned = stats.total * REVIEWER_XP;
    return res.json(stats);
  } catch (err) {
    console.error('[GET /review/stats]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
