'use strict';
const router   = require('express').Router();
const bcrypt   = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const db       = require('../db/pool');
const { signToken } = require('../middleware/auth');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── Helpers ───────────────────────────────────────────────

function deriveUsername(name) {
  return (name || 'user')
    .replace(/\s+/g, '_')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .substring(0, 16) || 'user';
}

async function uniqueUsername(base) {
  let candidate = base;
  let attempt   = 0;
  while (true) {
    const { rows } = await db.query('SELECT id FROM users WHERE username=$1', [candidate]);
    if (!rows.length) return candidate;
    attempt++;
    candidate = `${base.substring(0, 12)}_${attempt}`;
  }
}

function buildUserPayload(user) {
  return {
    id:           user.id,
    username:     user.username,
    display_name: user.display_name,
    pfp_url:      user.pfp_url,
    total_xp:     user.total_xp,
    is_mod:       user.is_mod,
  };
}

// ── POST /api/auth/google ──────────────────────────────────
// Client sends the ID token from Google GIS.
router.post('/google', async (req, res) => {
  const { id_token } = req.body;
  if (!id_token) return res.status(400).json({ error: 'id_token required' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken:  id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Google token: ' + err.message });
  }

  const { sub: googleSub, email, name, picture } = payload;

  try {
    // Look up existing user by google_sub OR email
    let { rows } = await db.query(
      'SELECT * FROM users WHERE google_sub=$1 OR (email=$2 AND email IS NOT NULL)',
      [googleSub, email]
    );
    let user = rows[0];

    if (!user) {
      // First-time sign-in: create account
      const username = await uniqueUsername(deriveUsername(name));
      const result = await db.query(
        `INSERT INTO users (username, display_name, email, pfp_url, auth_provider, google_sub)
         VALUES ($1,$2,$3,$4,'google',$5) RETURNING *`,
        [username, name || username, email, picture, googleSub]
      );
      user = result.rows[0];
    } else if (!user.google_sub) {
      // Account existed via email — link Google
      await db.query('UPDATE users SET google_sub=$1 WHERE id=$2', [googleSub, user.id]);
      user.google_sub = googleSub;
    }

    return res.json({ token: signToken(user), user: buildUserPayload(user) });
  } catch (err) {
    console.error('[auth/google]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/apple ───────────────────────────────────
//
// ⚠️  PARTIALLY IMPLEMENTED — Apple Sign-In server-side token verification
//     requires specific steps I'm not fabricating:
//
//     1. Apple sends a `code` (authorization code) and an `id_token` (JWT).
//     2. You must exchange the `code` at https://appleid.apple.com/auth/token
//        using a client_secret you generate by signing a JWT with your ES256
//        private key (.p8 file from Apple Developer portal).
//     3. Then verify the returned id_token against Apple's JWKS endpoint.
//
//     The jose or apple-signin-auth npm packages handle step 3.
//     Step 2 is left as a TODO below because the exact payload shape differs
//     between native and web flows, and I don't want to give you broken code.
//
router.post('/apple', async (req, res) => {
  const { id_token, user: appleUser } = req.body;
  if (!id_token) return res.status(400).json({ error: 'id_token required' });

  // TODO: Verify id_token using apple-signin-auth or jose:
  //   const appleSignin = require('apple-signin-auth');
  //   const payload = await appleSignin.verifyIdToken(id_token, {
  //     audience: process.env.APPLE_SERVICE_ID,
  //     ignoreExpiration: false,
  //   });
  //   const appleSub = payload.sub;

  return res.status(501).json({
    error: 'Apple Sign-In backend verification not yet implemented',
    hint:  'See routes/auth.js — install apple-signin-auth and complete the TODO block',
  });
});

// ── POST /api/auth/email/signup ────────────────────────────
router.post('/email/signup', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'username, email, and password required' });
  if (!/^[a-z0-9_]{2,24}$/.test(username))
    return res.status(400).json({ error: 'Username must be 2–24 lowercase letters, numbers or underscores' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      `INSERT INTO users (username, display_name, email, password_hash, auth_provider)
       VALUES ($1,$1,$2,$3,'email') RETURNING *`,
      [username, email.toLowerCase(), hash]
    );
    const user = rows[0];
    return res.status(201).json({ token: signToken(user), user: buildUserPayload(user) });
  } catch (err) {
    if (err.code === '23505') {
      const field = err.constraint?.includes('email') ? 'email' : 'username';
      return res.status(409).json({ error: `That ${field} is already taken` });
    }
    console.error('[auth/email/signup]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/email/signin ────────────────────────────
router.post('/email/signin', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password required' });

  try {
    const { rows } = await db.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
    const user = rows[0];
    if (!user || !user.password_hash) {
      // Generic message — don't leak which field is wrong
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    return res.json({ token: signToken(user), user: buildUserPayload(user) });
  } catch (err) {
    console.error('[auth/email/signin]', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
