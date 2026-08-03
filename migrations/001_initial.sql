SET search_path TO app, public;

CREATE TABLE IF NOT EXISTS app.schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.runtime_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.market_ticks (
  id uuid PRIMARY KEY,
  exchange text NOT NULL,
  symbol text NOT NULL,
  bid numeric(28, 12),
  ask numeric(28, 12),
  last_price numeric(28, 12) NOT NULL,
  volume_24h numeric(28, 12),
  quote_volume_24h numeric(28, 12),
  observed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS market_ticks_symbol_observed_idx
  ON app.market_ticks (symbol, observed_at DESC);

CREATE TABLE IF NOT EXISTS app.orders (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('paper', 'live')),
  exchange text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  type text NOT NULL CHECK (type IN ('market', 'limit')),
  status text NOT NULL,
  requested_quantity numeric(28, 12) NOT NULL,
  filled_quantity numeric(28, 12) NOT NULL DEFAULT 0,
  limit_price numeric(28, 12),
  avg_fill_price numeric(28, 12),
  quote_value numeric(28, 12),
  fees_quote numeric(28, 12) NOT NULL DEFAULT 0,
  client_order_id text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_created_idx
  ON app.orders (created_at DESC);

CREATE TABLE IF NOT EXISTS app.trades (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES app.orders(id),
  mode text NOT NULL CHECK (mode IN ('paper', 'live')),
  exchange text NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity numeric(28, 12) NOT NULL,
  price numeric(28, 12) NOT NULL,
  quote_value numeric(28, 12) NOT NULL,
  fee_quote numeric(28, 12) NOT NULL DEFAULT 0,
  executed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trades_symbol_executed_idx
  ON app.trades (symbol, executed_at DESC);

CREATE INDEX IF NOT EXISTS trades_executed_idx
  ON app.trades (executed_at DESC);

CREATE TABLE IF NOT EXISTS app.positions (
  symbol text PRIMARY KEY,
  base_quantity numeric(28, 12) NOT NULL,
  avg_entry_price numeric(28, 12) NOT NULL,
  realized_pnl_quote numeric(28, 12) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.risk_events (
  id uuid PRIMARY KEY,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  gate text NOT NULL,
  symbol text,
  decision text NOT NULL CHECK (decision IN ('allow', 'block', 'observe')),
  message text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS risk_events_created_idx
  ON app.risk_events (created_at DESC);

CREATE TABLE IF NOT EXISTS app.decision_journal (
  id uuid PRIMARY KEY,
  symbol text NOT NULL,
  signal text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow', 'block', 'observe')),
  reason text NOT NULL,
  score numeric(12, 6),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS decision_journal_created_idx
  ON app.decision_journal (created_at DESC);
