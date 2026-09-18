-- Run with all application writers stopped. Reconstruct historic weighted-cost P/L
-- before making daily risk checks depend on the per-trade ledger.
ALTER TABLE app.trades ADD COLUMN realized_pnl_quote numeric(28, 12);

DO $$
DECLARE
  symbol_row record;
  trade_row record;
  position_row record;
  quantity numeric;
  average_price numeric;
  realized numeric;
  trade_realized numeric;
BEGIN
  FOR symbol_row IN SELECT DISTINCT symbol FROM app.trades LOOP
    quantity := 0;
    average_price := 0;
    realized := 0;
    -- Mixed-side timestamp ties have no reliable historical execution order.
    IF EXISTS (
      SELECT 1 FROM app.trades WHERE symbol = symbol_row.symbol
      GROUP BY executed_at HAVING count(DISTINCT side) > 1
    ) THEN
      RAISE EXCEPTION 'Ambiguous historical trade order for %; reconcile before migration', symbol_row.symbol;
    END IF;
    FOR trade_row IN
      SELECT * FROM app.trades WHERE symbol = symbol_row.symbol ORDER BY executed_at, id
    LOOP
      trade_realized := 0;
      IF trade_row.side = 'buy' THEN
        average_price := round((quantity * average_price + trade_row.quote_value + trade_row.fee_quote)
          / (quantity + trade_row.quantity), 12);
        quantity := quantity + trade_row.quantity;
      ELSE
        IF trade_row.quantity > quantity THEN
          RAISE EXCEPTION 'Incomplete historical inventory for %; reconcile before migration', symbol_row.symbol;
        END IF;
        trade_realized := (trade_row.price - average_price) * trade_row.quantity - trade_row.fee_quote;
        realized := realized + trade_realized;
        quantity := quantity - trade_row.quantity;
        IF quantity = 0 THEN average_price := 0; END IF;
      END IF;
      UPDATE app.trades SET realized_pnl_quote = trade_realized WHERE id = trade_row.id;
    END LOOP;
    SELECT * INTO position_row FROM app.positions WHERE symbol = symbol_row.symbol;
    IF NOT FOUND OR abs(position_row.base_quantity - quantity) > 0.00000001
      OR abs(position_row.realized_pnl_quote - realized) > 0.000001
      -- Historical quantities were rounded to 12 decimals independently of price.
      -- Compare cost-basis value, not unit price, using one micro-quote tolerance.
      OR abs((position_row.avg_entry_price - average_price) * quantity) > 0.000001 THEN
      RAISE EXCEPTION 'Historical ledger does not match position for %; reconcile before migration', symbol_row.symbol;
    END IF;
  END LOOP;
END $$;

-- No default: older application writers must fail rather than omit realized P/L.
ALTER TABLE app.trades ALTER COLUMN realized_pnl_quote SET NOT NULL;
