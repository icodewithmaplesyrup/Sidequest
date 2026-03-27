'use strict';
/**
 * dev-server.js
 * ─────────────────────────────────────────────────────────
 * Local development backend for sidequest7.html.
 *
 * Requires NO native modules.  State is persisted to
 * dev/sidequest-dev.json (auto-created, gitignored).
 * Delete that file to start fresh.
 *
 * Usage:
 *   npm run dev               → starts this server
 *   open http://localhost:4000
 *
 * Pipeline to test end-to-end:
 *   1.  Login as "alice"      → submit a quest via the UI
 *   2.  POST /api/quests/:id/video-ready   (simulates video attach)
 *   3.  Login as "mod_user"   → cast 5 votes on the review queue
 *   4.  Quest auto-transitions to "posted" and appears on feed + map
 *
 * Debug endpoints:
 *   GET    /debug/state   — full JSON dump
 *   DELETE /debug/reset   — wipe & re-seed
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const cors    = require('cors');
const morgan  = require('morgan');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const PORT      = process.env.DEV_PORT || 4000;
// Point this at wherever sidequest7.html lives on your machine.
// The default assumes: project-root/sidequest7.html alongside this backend folder.
const HTML_PATH = path.resolve(__dirname, '../../sidequest7.html');
const DB_PATH   = path.join(__dirname, 'sidequest-dev.json');
const SECRET    = 'dev-secret-not-for-production';
const MIN_VOTES = 5;

// ─────────────────────────────────────────────────────────
//  JSON file-based store
// ─────────────────────────────────────────────────────────

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (_) { return null; }
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function seedDB() {
  const now = new Date().toISOString();
  const data = {
    users: [
      { id:'user-mod',   username:'mod_user', display_name:'Mod User', bio:'',                    pfp_url:null, email:'mod@dev.local',   password_hash:null, total_xp:5000, is_mod:true,  equipped_ring:null, equipped_background:null, created_at:now },
      { id:'user-alice', username:'alice',    display_name:'Alice',    bio:'Daring the ordinary 🗡️', pfp_url:null, email:'alice@dev.local', password_hash:null, total_xp:1240, is_mod:false, equipped_ring:null, equipped_background:null, created_at:now },
      { id:'user-bob',   username:'bob_k',    display_name:'Bob K.',   bio:'',                    pfp_url:null, email:'bob@dev.local',   password_hash:null, total_xp:420,  is_mod:false, equipped_ring:null, equipped_background:null, created_at:now },
    ],
    quests: [
      { id:uuidv4(), author_id:'user-alice', title:'Walked through the mall in full knight armor',      description:'', difficulty:'hard',   xp_base:500,  xp_final:500,  status:'posted', latitude:41.8827, longitude:-87.6233, location_name:'Chicago, IL',        video_path:null, completion_count:94,  is_trailblazer:true,  submitted_at:now, posted_at:now },
      { id:uuidv4(), author_id:'user-alice', title:'Asked a stranger to narrate my grocery trip',       description:'', difficulty:'medium', xp_base:250,  xp_final:250,  status:'posted', latitude:30.2672, longitude:-97.7431, location_name:'Austin, TX',         video_path:null, completion_count:312, is_trailblazer:false, submitted_at:now, posted_at:now },
      { id:uuidv4(), author_id:'user-alice', title:'Ordered food in a full pirate accent',              description:'', difficulty:'medium', xp_base:250,  xp_final:250,  status:'posted', latitude:34.0522, longitude:-118.2437,location_name:'Los Angeles, CA',     video_path:null, completion_count:201, is_trailblazer:false, submitted_at:now, posted_at:now },
      { id:uuidv4(), author_id:'user-alice', title:'Paid entirely in pennies at checkout',              description:'', difficulty:'easy',   xp_base:100,  xp_final:100,  status:'posted', latitude:40.7128, longitude:-74.0060, location_name:'New York, NY',       video_path:null, completion_count:528, is_trailblazer:false, submitted_at:now, posted_at:now },
      { id:uuidv4(), author_id:'user-alice', title:'Convinced 3 strangers to high-five simultaneously', description:'', difficulty:'legend', xp_base:1000, xp_final:1000, status:'posted', latitude:51.5074, longitude:-0.1278,  location_name:'London, UK',         video_path:null, completion_count:22,  is_trailblazer:true,  submitted_at:now, posted_at:now },
      // One quest sitting in review queue for mod testing
      { id:uuidv4(), author_id:'user-bob',   title:'Narrated my commute in a sports-caster voice',     description:'', difficulty:'easy',   xp_base:100,  xp_final:null, status:'in_review', latitude:34.0195, longitude:-118.4912, location_name:'Manhattan Beach, CA', video_path:'sim_bob_01.mp4', completion_count:0, is_trailblazer:false, submitted_at:now, posted_at:null },
    ],
    review_votes:    [],
    completions:     [],
    xp_transactions: [],
  };
  saveDB(data);
  return data;
}

let db = loadDB() || seedDB();
const save = () => saveDB(db);

// ─────────────────────────────────────────────────────────
//  Auth helpers
// ─────────────────────────────────────────────────────────

const signToken = (u) =>
  jwt.sign({ sub: u.id, username: u.username, is_mod: !!u.is_mod }, SECRET, { expiresIn: '7d' });

const verifyToken = (req) => {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  try { return jwt.verify(h.slice(7), SECRET); } catch (_) { return null; }
};

const mw = {
  auth: (req, res, next) => {
    req.user = verifyToken(req);
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    next();
  },
  mod: (req, res, next) => {
    req.user = verifyToken(req);
    if (!req.user)       return res.status(401).json({ error: 'Unauthorized' });
    if (!req.user.is_mod) return res.status(403).json({ error: 'Moderator required' });
    next();
  },
};

// ─────────────────────────────────────────────────────────
//  Level calc (mirrors client-side)
// ─────────────────────────────────────────────────────────

function calcLevel(xp) {
  let lvl = 1, gap = 100, threshold = 100;
  while (xp >= threshold) { lvl++; gap = Math.floor(gap * 1.5); threshold += gap; }
  const titles = ['Novice','Initiate','Adventurer','Explorer','Trailblazer','Knight','Shadow Knight','Legend','Mythic','Immortal'];
  return { level: lvl, title: titles[Math.min(lvl - 1, titles.length - 1)] };
}

// ─────────────────────────────────────────────────────────
//  Vote decision engine
//  Runs after every vote.  Once MIN_VOTES reached → decide.
// ─────────────────────────────────────────────────────────

function evaluateQuest(questId) {
  const votes = db.review_votes.filter(v => v.quest_id === questId);
  if (votes.length < MIN_VOTES) return;

  const tally = { approved: 0, more_xp: 0, rejected: 0 };
  votes.forEach(v => { tally[v.vote] = (tally[v.vote] || 0) + 1; });
  const total = votes.length;
  const quest = db.quests.find(q => q.id === questId);

  if (tally.rejected > total / 2) {
    quest.status = 'rejected';
  } else {
    if (tally.more_xp > tally.approved) {
      const suggestions = votes
        .filter(v => v.vote === 'more_xp' && v.xp_suggest)
        .map(v => Number(v.xp_suggest));
      if (suggestions.length) {
        const avg   = suggestions.reduce((a, b) => a + b, 0) / suggestions.length;
        const tiers = [100, 250, 500, 1000];
        quest.xp_final = tiers.reduce((p, c) => Math.abs(c - avg) < Math.abs(p - avg) ? c : p);
      }
    }
    quest.xp_final  = quest.xp_final ?? quest.xp_base;
    quest.status    = 'posted';
    quest.posted_at = new Date().toISOString();
  }
  save();
}

// ─────────────────────────────────────────────────────────
//  Express
// ─────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan(':method :url :status :response-time ms'));

// ── Serve sidequest7.html with injected dev bootstrap ─────
app.get('/', (req, res) => {
  if (!fs.existsSync(HTML_PATH)) {
    return res.send(`
      <h2 style="font-family:monospace;padding:2rem">sidequest7.html not found</h2>
      <p style="font-family:monospace;padding:0 2rem">Expected: <code>${HTML_PATH}</code></p>
      <p style="font-family:monospace;padding:0 2rem">Edit <strong>HTML_PATH</strong> in <code>dev/dev-server.js</code></p>
    `);
  }

  let html = fs.readFileSync(HTML_PATH, 'utf8');

  // Script injected before </body>: patches submitQuest + castVote
  // to call the real API without touching sidequest7.html.
  const inject = `
<script>
/* ════════ Sidequest Dev Bootstrap ════════ */
const API_BASE = 'http://localhost:${PORT}/api';
let _devToken  = sessionStorage.getItem('sq_dev_token');

async function _api(method, path, body) {
  const r = await fetch(API_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ..._devToken ? { 'Authorization': 'Bearer ' + _devToken } : {},
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

/* Dev quick-login — called by debug bar */
window.devLogin = async (username) => {
  const data = await _api('POST', '/auth/dev-login', { username });
  if (!data.token) { showToast('Login failed: ' + data.error); return; }
  _devToken = data.token;
  sessionStorage.setItem('sq_dev_token', _devToken);
  state.username  = data.user.username;
  state.totalXp   = data.user.total_xp;
  state.isMod     = data.user.is_mod;
  state.isLoggedIn = true;
  completeSignIn('email', null, data.user.display_name, null);
  renderNavBars(document.querySelector('.screen.active')?.id?.replace('screen-','') || 'feed');
  showToast('✓ Logged in as ' + data.user.username + (data.user.is_mod ? ' 🛡' : ''));
};

/* Patch submitQuest → real API */
window.submitQuest = async function() {
  const title = document.getElementById('questTitle')?.value?.trim();
  if (!title) { showToast('Add a quest title first!'); return; }
  if (!_devToken) { showToast('Not signed in — use debug bar Dev Login'); return; }
  const diff   = document.querySelector('.diff-chip.selected')?.dataset?.xp || '250';
  const diffMap = {'100':'easy','250':'medium','500':'hard','1000':'legend'};
  const data   = await _api('POST', '/quests', { title, difficulty: diffMap[diff] || 'medium' });
  if (data.error) { showToast('Submit error: ' + data.error); return; }
  showToast('✓ Quest submitted (id: ' + data.id.slice(0,8) + '…) — status: pending_review');
  console.info('[Dev] Submitted quest', data);
  setTimeout(() => goScreen('feed'), 1500);
};

/* Patch castVote → real API */
window.castVote = async function(cardId, type) {
  if (!_devToken) { showToast('Not signed in'); return; }
  const voteMap = { approved:'approved', more:'more_xp', reject:'rejected' };
  const queue   = await _api('GET', '/review/queue');
  const quest   = queue.queue?.[0];
  if (!quest) { showToast('Review queue is empty'); return; }

  const data = await _api('POST', '/review/' + quest.id + '/vote', { vote: voteMap[type] });
  if (data.error) { showToast('Vote error: ' + data.error); return; }

  /* Mirror original UI update */
  const configs = {
    approved: { cls:'status-approved', txt:'Approved ✓', msg:'Approved — +15 XP earned ✓',           color:'#166534' },
    more:     { cls:'status-moreXP',   txt:'More XP ★',  msg:'Voted higher XP — +15 XP earned',      color:'#92400e' },
    reject:   { cls:'status-rejected', txt:'Rejected ✗', msg:'Quest rejected — +15 XP still earned', color:'#991b1b' },
  };
  const cfg     = configs[type];
  const card    = document.getElementById('review-card-' + cardId);
  const statusEl = card?.querySelector('.review-status');
  const voteRow  = document.getElementById('vote-row-' + cardId);
  if (statusEl) { statusEl.className = 'review-status ' + cfg.cls; statusEl.textContent = cfg.txt; }
  if (voteRow)  { voteRow.innerHTML  = '<div style="padding:4px 0;font-size:11px;color:' + cfg.color + ';font-weight:600;">' + cfg.msg + '</div>'; }

  showToast('+15 XP!  Quest is now: ' + data.quest_status);
  console.info('[Dev] Vote result', data);

  /* Sync XP from server */
  const me = await _api('GET', '/users/me');
  if (me.total_xp !== undefined) { state.totalXp = me.total_xp; updateProfileUI(); }
};

/* Tiny status badge */
const badge = document.createElement('div');
badge.style.cssText = 'position:fixed;bottom:0;left:0;background:#111;color:#a3e635;font-family:monospace;font-size:9px;padding:2px 6px;z-index:9999;pointer-events:none;opacity:.85;';
badge.textContent = '⚙ DEV :${PORT}';
document.body.appendChild(badge);

console.info('[DevServer] API_BASE =', API_BASE);
console.info('[DevServer] Debug state → http://localhost:${PORT}/debug/state');
</script>`;

  html = html.replace('</body>', inject + '\n</body>');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ─────────────────────────────────────────────────────────
//  AUTH
// ─────────────────────────────────────────────────────────

app.post('/api/auth/dev-login', (req, res) => {
  const user = db.users.find(u => u.username === req.body.username);
  if (!user) return res.status(404).json({ error: `"${req.body.username}" not found. Try: alice, bob_k, mod_user` });
  res.json({ token: signToken(user), user });
});

app.post('/api/auth/email/signup', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'username, email, password required' });
  if (db.users.find(u => u.username === username))
    return res.status(409).json({ error: 'Username already taken' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, display_name: username, bio: '', pfp_url: null, email,
    password_hash: hash, total_xp: 0, is_mod: false, equipped_ring: null, equipped_background: null,
    created_at: new Date().toISOString() };
  db.users.push(user); save();
  res.status(201).json({ token: signToken(user), user });
});

app.post('/api/auth/email/signin', async (req, res) => {
  const user = db.users.find(u => u.email === req.body.email);
  if (!user?.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(req.body.password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signToken(user), user });
});

// ─────────────────────────────────────────────────────────
//  QUESTS
// ─────────────────────────────────────────────────────────

app.get('/api/quests', (req, res) => {
  const quests = db.quests
    .filter(q => q.status === 'posted')
    .sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at))
    .slice(0, 30)
    .map(q => {
      const author = db.users.find(u => u.id === q.author_id);
      return { ...q, author_username: author?.username, author_pfp_url: author?.pfp_url };
    });
  res.json({ quests });
});

app.get('/api/quests/map', (req, res) => {
  res.json({
    quests: db.quests
      .filter(q => q.status === 'posted' && q.latitude != null)
      .map(({ id, title, xp_final, xp_base, difficulty, latitude, longitude, completion_count, is_trailblazer }) =>
        ({ id, title, xp: xp_final ?? xp_base, difficulty, lat: latitude, lng: longitude, completions: completion_count, trailblazer: !!is_trailblazer })),
  });
});

app.get('/api/quests/:id', (req, res) => {
  const q = db.quests.find(q => q.id === req.params.id);
  if (!q || q.status !== 'posted') return res.status(404).json({ error: 'Quest not found' });
  const author = db.users.find(u => u.id === q.author_id);
  res.json({ ...q, author_username: author?.username });
});

app.post('/api/quests', mw.auth, (req, res) => {
  const { title, description, difficulty, latitude, longitude, location_name } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  const xpMap = { easy: 100, medium: 250, hard: 500, legend: 1000 };
  const quest = {
    id: uuidv4(), author_id: req.user.sub,
    title: title.trim(), description: description || '',
    difficulty: difficulty || 'medium', xp_base: xpMap[difficulty] || 250, xp_final: null,
    status: 'pending_review',
    latitude: latitude ?? null, longitude: longitude ?? null, location_name: location_name ?? null,
    video_path: null, completion_count: 0, is_trailblazer: false,
    submitted_at: new Date().toISOString(), posted_at: null,
  };
  db.quests.push(quest); save();
  res.status(201).json(quest);
});

// Simulate video being attached — moves quest into review queue
app.post('/api/quests/:id/video-ready', mw.auth, (req, res) => {
  const quest = db.quests.find(q => q.id === req.params.id && q.author_id === req.user.sub);
  if (!quest) return res.status(404).json({ error: 'Quest not found or not yours' });
  if (!['pending_review','draft'].includes(quest.status))
    return res.status(409).json({ error: 'Cannot attach video in status: ' + quest.status });
  quest.status     = 'in_review';
  quest.video_path = 'simulated_' + quest.id.slice(0, 8) + '.mp4';
  save();
  res.json({ message: 'Quest moved to in_review', quest });
});

app.post('/api/quests/:id/complete', mw.auth, (req, res) => {
  const quest = db.quests.find(q => q.id === req.params.id && q.status === 'posted');
  if (!quest) return res.status(404).json({ error: 'Quest not found' });
  if (quest.author_id === req.user.sub) return res.status(403).json({ error: 'Cannot complete your own quest' });
  if (db.completions.find(c => c.quest_id === quest.id && c.user_id === req.user.sub))
    return res.status(409).json({ error: 'Already completed' });

  const xpEarned = quest.xp_final ?? quest.xp_base;
  db.completions.push({ id: uuidv4(), quest_id: quest.id, user_id: req.user.sub, xp_earned: xpEarned });
  quest.completion_count++;
  const user = db.users.find(u => u.id === req.user.sub);
  if (user) user.total_xp += xpEarned;
  const author = db.users.find(u => u.id === quest.author_id);
  if (author) author.total_xp += Math.max(1, Math.round(xpEarned * 0.007));
  save();
  res.status(201).json({ xp_earned: xpEarned, message: `+${xpEarned} XP earned!` });
});

// ─────────────────────────────────────────────────────────
//  REVIEW
// ─────────────────────────────────────────────────────────

app.get('/api/review/queue', mw.mod, (req, res) => {
  const queue = db.quests
    .filter(q => q.status === 'in_review' &&
      !db.review_votes.find(v => v.quest_id === q.id && v.voter_id === req.user.sub))
    .slice(0, 20)
    .map(q => {
      const author     = db.users.find(u => u.id === q.author_id);
      const vote_count = db.review_votes.filter(v => v.quest_id === q.id).length;
      return { ...q, author_username: author?.username, vote_count };
    });
  res.json({ queue, min_votes: MIN_VOTES });
});

app.post('/api/review/:questId/vote', mw.mod, (req, res) => {
  const { vote, xp_suggest } = req.body;
  const questId = req.params.questId;
  if (!['approved','more_xp','rejected'].includes(vote))
    return res.status(400).json({ error: 'vote must be approved | more_xp | rejected' });
  const quest = db.quests.find(q => q.id === questId);
  if (!quest || quest.status !== 'in_review')
    return res.status(404).json({ error: 'Quest not in review' });
  if (db.review_votes.find(v => v.quest_id === questId && v.voter_id === req.user.sub))
    return res.status(409).json({ error: 'Already voted' });

  db.review_votes.push({ id: uuidv4(), quest_id: questId, voter_id: req.user.sub, vote, xp_suggest: xp_suggest ?? null });
  const voter = db.users.find(u => u.id === req.user.sub);
  if (voter) voter.total_xp += 15;
  evaluateQuest(questId);
  save();

  const updated = db.quests.find(q => q.id === questId);
  res.json({ xp_earned: 15, quest_status: updated.status, xp_final: updated.xp_final });
});

app.get('/api/review/stats', mw.mod, (req, res) => {
  const myVotes = db.review_votes.filter(v => v.voter_id === req.user.sub);
  const s = { approved: 0, more_xp: 0, rejected: 0 };
  myVotes.forEach(v => { s[v.vote] = (s[v.vote] || 0) + 1; });
  res.json({ ...s, total: myVotes.length, xp_earned: myVotes.length * 15 });
});

// ─────────────────────────────────────────────────────────
//  USERS
// ─────────────────────────────────────────────────────────

app.get('/api/users/me', mw.auth, (req, res) => {
  const u = db.users.find(u => u.id === req.user.sub);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { level, title } = calcLevel(u.total_xp);
  const { password_hash, ...safe } = u;
  res.json({ ...safe, level, title });
});

app.patch('/api/users/me', mw.auth, (req, res) => {
  const u = db.users.find(u => u.id === req.user.sub);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { username, display_name, bio, equipped_ring, equipped_background } = req.body;
  if (username !== undefined) {
    if (db.users.find(x => x.username === username && x.id !== u.id))
      return res.status(409).json({ error: 'Username taken' });
    u.username = username;
  }
  if (display_name  !== undefined) u.display_name  = display_name.slice(0, 40);
  if (bio           !== undefined) u.bio            = bio.slice(0, 160);
  if (equipped_ring !== undefined) u.equipped_ring  = equipped_ring || null;
  if (equipped_background !== undefined) u.equipped_background = equipped_background || null;
  save();
  const { password_hash, ...safe } = u;
  res.json(safe);
});

app.get('/api/users/me/quests', mw.auth, (req, res) => {
  const quests = db.quests.filter(q => q.author_id === req.user.sub)
    .sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at)).slice(0, 50);
  res.json({ quests });
});

app.get('/api/users/leaderboard', (req, res) => {
  const lb = [...db.users]
    .sort((a, b) => b.total_xp - a.total_xp)
    .slice(0, 100)
    .map((u, i) => ({ id: u.id, username: u.username, display_name: u.display_name, pfp_url: u.pfp_url, total_xp: u.total_xp, rank: i + 1 }));
  res.json({ leaderboard: lb });
});

app.get('/api/users/:username', (req, res) => {
  const u = db.users.find(u => u.username === req.params.username);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { level, title } = calcLevel(u.total_xp);
  const { password_hash, ...safe } = u;
  res.json({ ...safe, level, title });
});

// ─────────────────────────────────────────────────────────
//  DEBUG
// ─────────────────────────────────────────────────────────

app.get('/debug/state', (req, res) => {
  res.json({
    users:        db.users.map(({ password_hash, ...u }) => u),
    quests:       db.quests.map(({ id, title, status, difficulty, xp_base, xp_final, author_id, completion_count }) =>
                    ({ id, title, status, difficulty, xp_base, xp_final, author_id, completion_count })),
    review_votes: db.review_votes,
    completions:  db.completions,
    db_path:      DB_PATH,
  });
});

app.delete('/debug/reset', (req, res) => {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  db = seedDB();
  res.json({ ok: true, message: 'Database wiped and re-seeded' });
});

// ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   Sidequest Dev Server  (zero native deps)       ║
╠══════════════════════════════════════════════════╣
║  App  →  http://localhost:${PORT}                    ║
║  API  →  http://localhost:${PORT}/api                ║
║  Debug→  http://localhost:${PORT}/debug/state        ║
╠══════════════════════════════════════════════════╣
║  Quick logins (POST /api/auth/dev-login):        ║
║   alice     regular user  (XP: 1240)             ║
║   mod_user  moderator     (XP: 5000)  🛡         ║
║   bob_k     regular user  (XP:  420)             ║
╠══════════════════════════════════════════════════╣
║  Full pipeline test:                             ║
║  1. Login as alice → Submit a quest via UI       ║
║  2. POST /api/quests/:id/video-ready  (simulate) ║
║  3. Login as mod_user → cast 5 votes             ║
║  4. Quest auto-posts → appears on feed + map     ║
╚══════════════════════════════════════════════════╝
`);
});
