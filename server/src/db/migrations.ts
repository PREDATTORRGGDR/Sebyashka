/**
 * Миграции хранятся в коде, чтобы не копировать .sql в dist.
 * Правило: существующие миграции НИКОГДА не редактируем - только добавляем новые.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "init",
    sql: /* sql */ `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id                 BIGINT PRIMARY KEY,               -- Telegram user id
  username           TEXT,
  first_name         TEXT NOT NULL DEFAULT '',
  language_code      TEXT,
  credits            INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  free_pack_used     BOOLEAN NOT NULL DEFAULT FALSE,
  pro_until          TIMESTAMPTZ,
  referral_code      TEXT NOT NULL UNIQUE,
  referred_by        BIGINT REFERENCES users(id),
  referral_rewarded  BOOLEAN NOT NULL DEFAULT FALSE,
  has_started_bot    BOOLEAN NOT NULL DEFAULT FALSE,
  bot_blocked        BOOLEAN NOT NULL DEFAULT FALSE,
  is_banned          BOOLEAN NOT NULL DEFAULT FALSE,
  selfie_path        TEXT,
  selfie_uploaded_at TIMESTAMPTZ,
  total_paid_stars   INTEGER NOT NULL DEFAULT 0,
  total_paid_usd     NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (referred_by IS NULL OR referred_by <> id)
);
CREATE INDEX users_referred_by_idx ON users(referred_by);

-- Журнал движения кредитов. Любое изменение users.credits идёт вместе с записью здесь.
CREATE TABLE ledger (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  delta       INTEGER NOT NULL,
  balance     INTEGER NOT NULL,
  reason      TEXT NOT NULL,        -- purchase | pack | refund_pack | referral | gift | admin | payment_refund | pro_monthly
  ref         TEXT,                 -- идемпотентный ключ (charge id, pack id и т.п.)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_reason_ref_uq ON ledger(reason, ref) WHERE ref IS NOT NULL;
CREATE INDEX ledger_user_idx ON ledger(user_id, created_at DESC);

CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             BIGINT NOT NULL REFERENCES users(id),
  product_id          TEXT NOT NULL,
  provider            TEXT NOT NULL CHECK (provider IN ('stars','cryptobot','admin')),
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','refunded','failed')),
  amount_stars        INTEGER,
  amount_usd          NUMERIC(12,2),
  invoice_url         TEXT,
  provider_invoice_id TEXT,
  provider_charge_id  TEXT UNIQUE,
  is_recurring        BOOLEAN NOT NULL DEFAULT FALSE,
  parent_order_id     UUID REFERENCES orders(id),
  paid_asset          TEXT,
  paid_amount         TEXT,
  raw                 JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at             TIMESTAMPTZ,
  refunded_at         TIMESTAMPTZ
);
CREATE INDEX orders_user_idx ON orders(user_id, created_at DESC);
CREATE INDEX orders_pending_crypto_idx ON orders(created_at) WHERE provider = 'cryptobot' AND status = 'pending';
CREATE UNIQUE INDEX orders_cryptobot_invoice_uq ON orders(provider_invoice_id) WHERE provider = 'cryptobot';

CREATE TABLE gifts (
  code         TEXT PRIMARY KEY,
  order_id     UUID NOT NULL UNIQUE REFERENCES orders(id),
  buyer_id     BIGINT NOT NULL REFERENCES users(id),
  credits      INTEGER NOT NULL CHECK (credits > 0),
  redeemed_by  BIGINT REFERENCES users(id),
  redeemed_at  TIMESTAMPTZ,
  revoked      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- packs одновременно и очередь задач (SELECT ... FOR UPDATE SKIP LOCKED).
CREATE TABLE packs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           BIGINT NOT NULL REFERENCES users(id),
  style_id          TEXT NOT NULL,
  is_free           BOOLEAN NOT NULL DEFAULT FALSE,
  credits_spent     INTEGER NOT NULL DEFAULT 0,
  priority          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','processing','needs_start','ready','failed')),
  total             INTEGER NOT NULL,
  done              INTEGER NOT NULL DEFAULT 0,
  selfie_path       TEXT NOT NULL,
  sticker_set_name  TEXT NOT NULL UNIQUE,
  sticker_set_title TEXT NOT NULL,
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  locked_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);
CREATE INDEX packs_queue_idx ON packs(priority DESC, created_at) WHERE status IN ('queued','processing');
CREATE INDEX packs_user_idx ON packs(user_id, created_at DESC);

CREATE TABLE stickers (
  id           BIGSERIAL PRIMARY KEY,
  pack_id      UUID NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  emotion_id   TEXT NOT NULL,
  emoji        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  file_path    TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  in_set       BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (pack_id, idx)
);

-- Простая продуктовая аналитика для воронки.
CREATE TABLE events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT,
  name       TEXT NOT NULL,
  props      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX events_name_time_idx ON events(name, created_at);
CREATE INDEX events_user_idx ON events(user_id, created_at);
`,
  },
  {
    id: 2,
    name: "admin_and_custom_prompt",
    sql: /* sql */ `
-- Пожелание пользователя к паку («в костюме супергероя», «с гитарой»).
ALTER TABLE packs ADD COLUMN custom_prompt TEXT;
-- Отключённые типы алертов для каждого админа.
CREATE TABLE admin_prefs (
  admin_id   BIGINT PRIMARY KEY,
  muted      TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_paid_idx ON orders(paid_at DESC) WHERE status = 'paid';
`,
  },
];
