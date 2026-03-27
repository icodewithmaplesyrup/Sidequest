-- ════════════════════════════════════════════════════════════
--  Sidequest — Production Schema
--  Run: psql -U sidequest -d sidequest -f schema.sql
-- ════════════════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";   -- for geo queries on map screen

-- ── Users ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username      TEXT UNIQUE NOT NULL CHECK (length(username) BETWEEN 2 AND 24 AND username ~ '^[a-z0-9_]+$'),
  display_name  TEXT NOT NULL DEFAULT '',
  bio           TEXT NOT NULL DEFAULT '',
  pfp_url       TEXT,
  email         TEXT UNIQUE,                 -- null for social-only accounts
  password_hash TEXT,                        -- null for social-only accounts
  total_xp      INTEGER NOT NULL DEFAULT 0,
  is_mod        BOOLEAN NOT NULL DEFAULT false,
  auth_provider TEXT CHECK (auth_provider IN ('google','apple','email')),
  google_sub    TEXT UNIQUE,
  apple_sub     TEXT UNIQUE,
  equipped_ring         TEXT,               -- cosmetic id
  equipped_background   TEXT,               -- cosmetic id
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email    ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google   ON users(google_sub);
CREATE INDEX IF NOT EXISTS idx_users_apple    ON users(apple_sub);
CREATE INDEX IF NOT EXISTS idx_users_xp       ON users(total_xp DESC);  -- leaderboard

-- ── Quests ────────────────────────────────────────────────
-- Status pipeline: draft → pending_review → in_review → posted | rejected
CREATE TYPE quest_status AS ENUM ('draft','pending_review','in_review','posted','rejected');
CREATE TYPE quest_difficulty AS ENUM ('easy','medium','hard','legend');

CREATE TABLE IF NOT EXISTS quests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  author_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL CHECK (length(title) BETWEEN 5 AND 120),
  description     TEXT NOT NULL DEFAULT '',
  difficulty      quest_difficulty NOT NULL DEFAULT 'medium',
  xp_base         INTEGER NOT NULL CHECK (xp_base IN (100,250,500,1000)),
  xp_final        INTEGER,                  -- set after mod consensus
  status          quest_status NOT NULL DEFAULT 'pending_review',

  -- Location
  latitude        DOUBLE PRECISION,
  longitude       DOUBLE PRECISION,
  location_name   TEXT,                     -- human label e.g. "Manhattan Beach, CA"
  geo_point       GEOGRAPHY(POINT, 4326),  -- postgis column for spatial queries

  -- Video
  video_path      TEXT,                     -- relative to UPLOAD_DIR
  video_duration  SMALLINT,                 -- seconds
  has_dual_cam    BOOLEAN NOT NULL DEFAULT false,

  -- Stats
  completion_count INTEGER NOT NULL DEFAULT 0,
  is_trailblazer   BOOLEAN NOT NULL DEFAULT false,

  -- Timestamps
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ,
  posted_at       TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quests_status     ON quests(status);
CREATE INDEX IF NOT EXISTS idx_quests_author     ON quests(author_id);
CREATE INDEX IF NOT EXISTS idx_quests_posted_at  ON quests(posted_at DESC) WHERE status = 'posted';
CREATE INDEX IF NOT EXISTS idx_quests_geo        ON quests USING GIST(geo_point) WHERE status = 'posted';

-- ── Review Votes ──────────────────────────────────────────
CREATE TYPE vote_type AS ENUM ('approved','more_xp','rejected');

CREATE TABLE IF NOT EXISTS review_votes (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quest_id   UUID NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  voter_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote       vote_type NOT NULL,
  xp_suggest INTEGER,                       -- only set when vote = 'more_xp'
  cast_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quest_id, voter_id)               -- one vote per reviewer per quest
);

CREATE INDEX IF NOT EXISTS idx_votes_quest  ON review_votes(quest_id);
CREATE INDEX IF NOT EXISTS idx_votes_voter  ON review_votes(voter_id);

-- ── Completions ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS completions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  quest_id    UUID NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  xp_earned   INTEGER NOT NULL,
  video_path  TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quest_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_completions_quest ON completions(quest_id);
CREATE INDEX IF NOT EXISTS idx_completions_user  ON completions(user_id);

-- ── XP Ledger ─────────────────────────────────────────────
CREATE TYPE xp_source AS ENUM ('completion','review_vote','royalty','admin');

CREATE TABLE IF NOT EXISTS xp_transactions (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      INTEGER NOT NULL,              -- positive = gain, negative = floor loss
  source     xp_source NOT NULL,
  ref_id     UUID,                          -- quest_id or completion_id
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_xp_user ON xp_transactions(user_id, created_at DESC);

-- ── Refresh Tokens ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

-- ── Trigger: update updated_at automatically ──────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_quests_updated_at
  BEFORE UPDATE ON quests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Trigger: award royalty XP when a completion is inserted ──
-- 0.7% of xp_earned goes to the quest author as royalty.
-- This keeps the logic server-side and auditable.
CREATE OR REPLACE FUNCTION award_royalty_on_completion()
RETURNS TRIGGER AS $$
DECLARE
  author  UUID;
  royalty INTEGER;
BEGIN
  SELECT author_id INTO author FROM quests WHERE id = NEW.quest_id;
  royalty := GREATEST(1, ROUND(NEW.xp_earned * 0.007));
  INSERT INTO xp_transactions (user_id, delta, source, ref_id, note)
    VALUES (author, royalty, 'royalty', NEW.id, 'Creator royalty');
  UPDATE users SET total_xp = total_xp + royalty WHERE id = author;
  -- Also increment completion counter on the quest
  UPDATE quests SET completion_count = completion_count + 1 WHERE id = NEW.quest_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_royalty_on_completion
  AFTER INSERT ON completions FOR EACH ROW EXECUTE FUNCTION award_royalty_on_completion();
