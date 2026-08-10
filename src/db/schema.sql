-- STARFLEX — Phase 2 (citizen platform) schema.
-- Everything lives in its own `starflex` schema so the platform is isolated and
-- can be moved to a dedicated database later with a single schema dump.

CREATE SCHEMA IF NOT EXISTS starflex;
SET search_path TO starflex;

-- ── Citizens ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS citizens (
  id                BIGSERIAL PRIMARY KEY,
  full_name         TEXT        NOT NULL,
  email             TEXT        UNIQUE,
  phone             TEXT        UNIQUE,
  password_hash     TEXT        NOT NULL,
  department        TEXT,
  commune           TEXT,
  birth_year        INT,
  email_verified    BOOLEAN     NOT NULL DEFAULT FALSE,
  phone_verified    BOOLEAN     NOT NULL DEFAULT FALSE,
  profile_complete  BOOLEAN     NOT NULL DEFAULT FALSE,
  points            INT         NOT NULL DEFAULT 0,
  role              TEXT        NOT NULL DEFAULT 'citizen',   -- citizen | admin
  status            TEXT        NOT NULL DEFAULT 'active',    -- active | suspended
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT citizens_contact_present CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- One-time codes for email/phone verification and login confirmation.
CREATE TABLE IF NOT EXISTS otp_codes (
  id           BIGSERIAL PRIMARY KEY,
  citizen_id   BIGINT      NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
  code         TEXT        NOT NULL,
  channel      TEXT        NOT NULL,              -- email | sms
  purpose      TEXT        NOT NULL DEFAULT 'verify',
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS otp_codes_citizen_idx ON otp_codes(citizen_id, consumed_at);

-- ── Civic education ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modules (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  title        TEXT NOT NULL,
  summary      TEXT,
  content      TEXT,
  duration_min INT  NOT NULL DEFAULT 10,
  points       INT  NOT NULL DEFAULT 10,
  sort_order   INT  NOT NULL DEFAULT 0,
  published    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS module_completions (
  id           BIGSERIAL PRIMARY KEY,
  citizen_id   BIGINT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
  module_id    BIGINT NOT NULL REFERENCES modules(id)  ON DELETE CASCADE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (citizen_id, module_id)
);

-- ── Consultations & surveys ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consultations (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  kind        TEXT NOT NULL DEFAULT 'consultation',  -- consultation | survey
  options     JSONB,                                  -- [{key,label}] for surveys
  points      INT  NOT NULL DEFAULT 15,
  opens_at    TIMESTAMPTZ,
  closes_at   TIMESTAMPTZ,
  published   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consultation_responses (
  id              BIGSERIAL PRIMARY KEY,
  consultation_id BIGINT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  citizen_id      BIGINT NOT NULL REFERENCES citizens(id)      ON DELETE CASCADE,
  choice          TEXT,
  comment         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (consultation_id, citizen_id)
);

-- ── Volunteering ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS volunteer_opportunities (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  location    TEXT,
  starts_at   TIMESTAMPTZ,
  points      INT NOT NULL DEFAULT 25,
  published   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS volunteer_signups (
  id             BIGSERIAL PRIMARY KEY,
  opportunity_id BIGINT NOT NULL REFERENCES volunteer_opportunities(id) ON DELETE CASCADE,
  citizen_id     BIGINT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'signed_up',   -- signed_up | validated
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (opportunity_id, citizen_id)
);

-- ── Notifications ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         BIGSERIAL PRIMARY KEY,
  citizen_id BIGINT REFERENCES citizens(id) ON DELETE CASCADE,  -- NULL = broadcast
  title      TEXT NOT NULL,
  body       TEXT,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notifications_citizen_idx ON notifications(citizen_id, read_at);

-- ── Points ledger (auditable trail behind every certificate) ────────────────
CREATE TABLE IF NOT EXISTS point_events (
  id         BIGSERIAL PRIMARY KEY,
  citizen_id BIGINT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
  points     INT    NOT NULL,
  reason     TEXT   NOT NULL,
  ref_type   TEXT,
  ref_id     BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS point_events_citizen_idx ON point_events(citizen_id, created_at DESC);

-- ── Certificates ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS certificates (
  id           BIGSERIAL PRIMARY KEY,
  citizen_id   BIGINT NOT NULL REFERENCES citizens(id) ON DELETE CASCADE,
  code         TEXT UNIQUE NOT NULL,           -- publicly verifiable code
  level        TEXT NOT NULL DEFAULT 'bronze', -- bronze | argent | or
  points_at_issue INT NOT NULL DEFAULT 0,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ,
  UNIQUE (citizen_id)
);

-- ── News / events (public content, managed in Phase 3 admin) ────────────────
CREATE TABLE IF NOT EXISTS posts (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'news',   -- news | event
  title       TEXT NOT NULL,
  excerpt     TEXT,
  body        TEXT,
  starts_at   TIMESTAMPTZ,
  published   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
