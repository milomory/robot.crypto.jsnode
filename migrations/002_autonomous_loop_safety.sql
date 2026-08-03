SET search_path TO app, public;

CREATE UNIQUE INDEX IF NOT EXISTS orders_client_order_id_unique_idx
  ON app.orders (client_order_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'app.orders'::regclass AND conname = 'orders_requested_quantity_positive'
  ) THEN
    ALTER TABLE app.orders ADD CONSTRAINT orders_requested_quantity_positive CHECK (requested_quantity > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'app.orders'::regclass AND conname = 'orders_filled_quantity_nonnegative'
  ) THEN
    ALTER TABLE app.orders ADD CONSTRAINT orders_filled_quantity_nonnegative CHECK (filled_quantity >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'app.orders'::regclass AND conname = 'orders_fees_quote_nonnegative'
  ) THEN
    ALTER TABLE app.orders ADD CONSTRAINT orders_fees_quote_nonnegative CHECK (fees_quote >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'app.orders'::regclass AND conname = 'orders_quote_value_positive_or_null'
  ) THEN
    ALTER TABLE app.orders ADD CONSTRAINT orders_quote_value_positive_or_null CHECK (quote_value IS NULL OR quote_value > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'app.trades'::regclass AND conname = 'trades_quantity_positive'
  ) THEN
    ALTER TABLE app.trades ADD CONSTRAINT trades_quantity_positive CHECK (quantity > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'app.trades'::regclass AND conname = 'trades_price_positive'
  ) THEN
    ALTER TABLE app.trades ADD CONSTRAINT trades_price_positive CHECK (price > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'app.trades'::regclass AND conname = 'trades_quote_value_positive'
  ) THEN
    ALTER TABLE app.trades ADD CONSTRAINT trades_quote_value_positive CHECK (quote_value > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'app.trades'::regclass AND conname = 'trades_fee_quote_nonnegative'
  ) THEN
    ALTER TABLE app.trades ADD CONSTRAINT trades_fee_quote_nonnegative CHECK (fee_quote >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'app.positions'::regclass AND conname = 'positions_base_quantity_nonnegative'
  ) THEN
    ALTER TABLE app.positions ADD CONSTRAINT positions_base_quantity_nonnegative CHECK (base_quantity >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid = 'app.positions'::regclass AND conname = 'positions_avg_entry_price_nonnegative'
  ) THEN
    ALTER TABLE app.positions ADD CONSTRAINT positions_avg_entry_price_nonnegative CHECK (avg_entry_price >= 0) NOT VALID;
  END IF;
END $$;
