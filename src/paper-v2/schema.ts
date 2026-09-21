import { z } from 'zod';

// Versioned fixture contract. Money never enters the model as a JSON number.
export const amountSchema = z.string().regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,8})?$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const time = z.number().int().positive().safe();
const venue = z.enum(['binance', 'bybit', 'okx']);
const symbol = z.literal('BTC/USDT');
const level = z.tuple([amountSchema, amountSchema]);
export const bookSchema = z.object({ venue, symbol,
  bids: z.array(level).min(1).max(50), asks: z.array(level).min(1).max(50),
  requestedAt: time, receivedAt: time, sourceAt: time.optional()
}).strict();
export const instrumentSchema = z.object({ venue, symbol, fetchedAt: time, trading: z.boolean(),
  minQuantity: amountSchema, maxQuantity: amountSchema, quantityStep: amountSchema,
  minNotional: amountSchema.optional(), maxNotional: amountSchema.optional()
}).strict();
export const costsSchema = z.object({ feeBps: z.number().int().min(0).max(9999),
  slippageBps: z.number().int().min(0).max(9999), feeAsset: z.literal('USDT') }).strict();
export const stepSchema = z.object({ id, at: time, book: bookSchema.optional(),
  intent: z.object({ side: z.enum(['buy', 'sell']), quantity: amountSchema }).strict().optional()
}).strict();
export const scenarioSchema = z.object({ schema: z.literal(1), model: z.literal('paper-v2-exact-1'),
  synthetic: z.literal(true), scenarioId: id, venue, symbol,
  opening: z.object({ USDT: amountSchema, BTC: amountSchema, costBasisUSDT: amountSchema.optional() }).strict(),
  costs: costsSchema, instrument: instrumentSchema,
  benchmark: z.object({ buyQuantityBTC: amountSchema }).strict(),
  steps: z.array(stepSchema).min(1).max(1000)
}).strict();
export type Scenario = z.infer<typeof scenarioSchema>;
export type Step = z.infer<typeof stepSchema>;
