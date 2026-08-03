import { randomUUID } from 'node:crypto';

import type { DbPool } from '../db/pool.js';
import type {
  MarketTicker,
  OrderRecord,
  OrderSide,
  PaperOrderRequest,
  PositionRecord,
  RiskEventInput,
  TradeRecord
} from '../domain/types.js';

const toNumber = (value: unknown, fallback = 0): number => {
  if (value === null || value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));

const mapOrder = (row: Record<string, unknown>): OrderRecord => ({
  id: String(row.id),
  mode: row.mode as OrderRecord['mode'],
  exchange: String(row.exchange),
  symbol: String(row.symbol),
  side: row.side as OrderSide,
  type: row.type as OrderRecord['type'],
  status: String(row.status),
  requestedQuantity: toNumber(row.requested_quantity),
  filledQuantity: toNumber(row.filled_quantity),
  limitPrice: row.limit_price === null ? undefined : toNumber(row.limit_price),
  avgFillPrice: row.avg_fill_price === null ? undefined : toNumber(row.avg_fill_price),
  quoteValue: row.quote_value === null ? undefined : toNumber(row.quote_value),
  feesQuote: toNumber(row.fees_quote),
  clientOrderId: String(row.client_order_id),
  reason: row.reason === null ? undefined : String(row.reason),
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at)
});

const mapTrade = (row: Record<string, unknown>): TradeRecord => ({
  id: String(row.id),
  orderId: String(row.order_id),
  mode: row.mode as TradeRecord['mode'],
  exchange: String(row.exchange),
  symbol: String(row.symbol),
  side: row.side as OrderSide,
  quantity: toNumber(row.quantity),
  price: toNumber(row.price),
  quoteValue: toNumber(row.quote_value),
  feeQuote: toNumber(row.fee_quote),
  executedAt: toDate(row.executed_at)
});

const mapPosition = (row: Record<string, unknown>): PositionRecord => ({
  symbol: String(row.symbol),
  baseQuantity: toNumber(row.base_quantity),
  avgEntryPrice: toNumber(row.avg_entry_price),
  realizedPnlQuote: toNumber(row.realized_pnl_quote),
  updatedAt: toDate(row.updated_at)
});

export interface PaperFillInput {
  exchange: string;
  request: PaperOrderRequest;
  price: number;
  feePercent: number;
}

export interface PaperFillResult {
  order: OrderRecord;
  trade: TradeRecord;
  position: PositionRecord;
}

export class TradeJournalService {
  constructor(private readonly pool: DbPool) {}

  async health(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }

  async recordMarketTick(ticker: MarketTicker): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO app.market_ticks (
          id, exchange, symbol, bid, ask, last_price, volume_24h, quote_volume_24h, observed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        randomUUID(),
        ticker.exchange,
        ticker.symbol,
        ticker.bid ?? null,
        ticker.ask ?? null,
        ticker.lastPrice,
        ticker.volume24h ?? null,
        ticker.quoteVolume24h ?? null,
        ticker.observedAt
      ]
    );
  }

  async recordRiskEvent(input: RiskEventInput): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO app.risk_events (
          id, severity, gate, symbol, decision, message, context
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        randomUUID(),
        input.severity,
        input.gate,
        input.symbol ?? null,
        input.decision,
        input.message,
        JSON.stringify(input.context ?? {})
      ]
    );
  }

  async recordDecision(input: {
    symbol: string;
    signal: string;
    decision: 'allow' | 'block' | 'observe';
    reason: string;
    score?: number;
    context?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO app.decision_journal (
          id, symbol, signal, decision, reason, score, context
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        randomUUID(),
        input.symbol,
        input.signal,
        input.decision,
        input.reason,
        input.score ?? null,
        JSON.stringify(input.context ?? {})
      ]
    );
  }

  async listRiskEvents(limit = 80) {
    const result = await this.pool.query(
      `
        SELECT id, severity, gate, symbol, decision, message, context, created_at
        FROM app.risk_events
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows;
  }

  async listDecisionJournal(limit = 80) {
    const result = await this.pool.query(
      `
        SELECT id, symbol, signal, decision, reason, score, context, created_at
        FROM app.decision_journal
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows;
  }

  async listOrders(limit = 80): Promise<OrderRecord[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM app.orders
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map(mapOrder);
  }

  async listTrades(limit = 80): Promise<TradeRecord[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM app.trades
        ORDER BY executed_at DESC
        LIMIT $1
      `,
      [limit]
    );

    return result.rows.map(mapTrade);
  }

  async listPositions(): Promise<PositionRecord[]> {
    const result = await this.pool.query(
      `
        SELECT *
        FROM app.positions
        WHERE base_quantity <> 0 OR realized_pnl_quote <> 0
        ORDER BY updated_at DESC
      `
    );

    return result.rows.map(mapPosition);
  }

  async getDailyBuyQuoteUsage(now = new Date()): Promise<number> {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);

    const result = await this.pool.query(
      `
        SELECT COALESCE(SUM(quote_value + fee_quote), 0) AS quote_usage
        FROM app.trades
        WHERE side = 'buy' AND executed_at >= $1
      `,
      [start]
    );

    return toNumber(result.rows[0]?.quote_usage);
  }

  async getRealizedPnlQuote(): Promise<number> {
    const result = await this.pool.query(
      `
        SELECT COALESCE(SUM(realized_pnl_quote), 0) AS realized
        FROM app.positions
      `
    );

    return toNumber(result.rows[0]?.realized);
  }

  async createPaperFill(input: PaperFillInput): Promise<PaperFillResult> {
    const client = await this.pool.connect();
    const now = new Date();
    const orderId = randomUUID();
    const tradeId = randomUUID();
    const clientOrderId = `paper_${now.getTime()}_${orderId.slice(0, 8)}`;
    const { request } = input;
    const quoteValue = request.baseQuantity * input.price;
    const feeQuote = quoteValue * (input.feePercent / 100);

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [request.symbol]);

      const existing = await client.query('SELECT * FROM app.positions WHERE symbol = $1 FOR UPDATE', [request.symbol]);
      const current = existing.rows[0] ? mapPosition(existing.rows[0]) : undefined;

      let nextQuantity = current?.baseQuantity ?? 0;
      let nextAvg = current?.avgEntryPrice ?? 0;
      let nextRealized = current?.realizedPnlQuote ?? 0;

      if (request.side === 'buy') {
        const grossCost = quoteValue + feeQuote;
        const previousCost = nextQuantity * nextAvg;
        nextQuantity += request.baseQuantity;
        nextAvg = nextQuantity > 0 ? (previousCost + grossCost) / nextQuantity : 0;
      } else {
        if (request.baseQuantity > nextQuantity) {
          throw new Error(`Paper sell exceeds open position for ${request.symbol}`);
        }

        nextRealized += (input.price - nextAvg) * request.baseQuantity - feeQuote;
        nextQuantity -= request.baseQuantity;
        if (Math.abs(nextQuantity) < 0.000000000001) {
          nextQuantity = 0;
          nextAvg = 0;
        }
      }

      await client.query(
        `
          INSERT INTO app.orders (
            id, mode, exchange, symbol, side, type, status, requested_quantity,
            filled_quantity, avg_fill_price, quote_value, fees_quote, client_order_id, reason,
            created_at, updated_at
          )
          VALUES ($1, 'paper', $2, $3, $4, $5, 'filled', $6, $7, $8, $9, $10, $11, $12, $13, $13)
        `,
        [
          orderId,
          input.exchange,
          request.symbol,
          request.side,
          request.type,
          request.baseQuantity,
          request.baseQuantity,
          input.price,
          quoteValue,
          feeQuote,
          clientOrderId,
          request.reason,
          now
        ]
      );

      await client.query(
        `
          INSERT INTO app.trades (
            id, order_id, mode, exchange, symbol, side, quantity, price, quote_value, fee_quote, executed_at
          )
          VALUES ($1, $2, 'paper', $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          tradeId,
          orderId,
          input.exchange,
          request.symbol,
          request.side,
          request.baseQuantity,
          input.price,
          quoteValue,
          feeQuote,
          now
        ]
      );

      await client.query(
        `
          INSERT INTO app.positions (symbol, base_quantity, avg_entry_price, realized_pnl_quote, updated_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (symbol)
          DO UPDATE SET
            base_quantity = EXCLUDED.base_quantity,
            avg_entry_price = EXCLUDED.avg_entry_price,
            realized_pnl_quote = EXCLUDED.realized_pnl_quote,
            updated_at = EXCLUDED.updated_at
        `,
        [request.symbol, nextQuantity, nextAvg, nextRealized, now]
      );

      await client.query('COMMIT');

      const [orderResult, tradeResult, positionResult] = await Promise.all([
        this.pool.query('SELECT * FROM app.orders WHERE id = $1', [orderId]),
        this.pool.query('SELECT * FROM app.trades WHERE id = $1', [tradeId]),
        this.pool.query('SELECT * FROM app.positions WHERE symbol = $1', [request.symbol])
      ]);

      return {
        order: mapOrder(orderResult.rows[0]),
        trade: mapTrade(tradeResult.rows[0]),
        position: mapPosition(positionResult.rows[0])
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
