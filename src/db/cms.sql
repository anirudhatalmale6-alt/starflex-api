-- ════════════════════════════════════════════════════════════════════════
-- STARFLEX CMS — the tables Christopher's team writes to.
--
-- Jeffery, 2 Oct 2026: "his team needs to be able to upload and manage
-- StarFlex content themselves without going through me... Their login must
-- give them ZERO access to GitHub, Render, MsouWout, HaitiBiznis, MyPlopPlop
-- or anybody else's data."
--
-- 🔑 cms_users is DELIBERATELY a separate table from `citizens`. A citizen
-- signing up on the public site must never be able to reach the CMS, and a CMS
-- editor is not a citizen of the programme. Two doors, two keys, no overlap.
-- ⛔ Everything here lives in the `starflex` schema (pool.js sets search_path),
-- so none of it can see another platform's data.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cms_users (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  -- admin can add and remove people; editor can only work on content
  role        TEXT NOT NULL DEFAULT 'editor',
  pass_hash   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | disabled
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login  TIMESTAMPTZ
);

-- Free text on the public pages, addressed by a key the page already knows.
CREATE TABLE IF NOT EXISTS content_blocks (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  BIGINT
);

-- Photos live in the database on purpose: the public site is static hosting
-- with nowhere to write, and adding a paid object store for a handful of
-- images would be spending money the project does not need to spend.
-- ⚠️ A hard size cap is enforced in the route, not here.
CREATE TABLE IF NOT EXISTS media (
  id          BIGSERIAL PRIMARY KEY,
  filename    TEXT,
  mime        TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  bytes       BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  BIGINT
);

-- News and events already existed as `posts`; give them a picture and an
-- author trail. ⛔ Additive only — nothing already published is disturbed.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS image_id   BIGINT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS ends_at    TIMESTAMPTZ;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS location   TEXT;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE posts ADD COLUMN IF NOT EXISTS updated_by BIGINT;

CREATE INDEX IF NOT EXISTS idx_posts_kind_pub ON posts (kind, published, created_at DESC);
