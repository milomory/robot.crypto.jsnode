import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const boolFromEnv = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined || value === '') {
      return undefined;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  });

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  HTTP_HOST: z.string().default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().positive().default(3580),
  DB_NAME: z.string().default('robot_crypto'),
  DB_USER: z.string().default('crypto_robot_app'),
  DB_PASSWORD: z.string().optional().default(''),
  DB_SSL: boolFromEnv.default('false'),
  DASHBOARD_AUTH_ENABLED: boolFromEnv,
  DASHBOARD_USERNAME: z.string().default('robot'),
  DASHBOARD_PASSWORD: z.string().optional().default(''),
  EXCHANGE_ID: z.string().default('binance'),
  SYMBOLS: z.string().default('BTC/USDT,ETH/USDT,SOL/USDT'),
  QUOTE_CURRENCY: z.string().default('USDT'),
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
  LIVE_TRADING_LOCKED: boolFromEnv.default('true'),
  RISK_MAX_ORDER_QUOTE: z.coerce.number().positive().default(50),
  RISK_DAILY_QUOTE_BUDGET: z.coerce.number().positive().default(250),
  RISK_MAX_DAILY_LOSS_QUOTE: z.coerce.number().positive().default(30),
  RISK_MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(5),
  RISK_MAX_SYMBOL_EXPOSURE_QUOTE: z.coerce.number().positive().default(150),
  RISK_MAX_SPREAD_PERCENT: z.coerce.number().positive().default(0.25),
  PAPER_FEE_PERCENT: z.coerce.number().min(0).default(0.1),
  AUTO_PAPER_TRADER_ENABLED: boolFromEnv.default('false'),
  AUTO_PAPER_TRADER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  AUTO_PAPER_ORDER_QUOTE: z.coerce.number().positive().default(10),
  AUTO_PAPER_MIN_24H_CHANGE_PERCENT: z.coerce.number().default(0.5),
  AUTO_PAPER_TAKE_PROFIT_PERCENT: z.coerce.number().positive().default(2),
  AUTO_PAPER_STOP_LOSS_PERCENT: z.coerce.number().positive().default(1.5),
  AUTO_PAPER_ALLOW_FALLBACK_MARKET_DATA: boolFromEnv.default('false'),
  AUTO_PAPER_RECORD_OBSERVATIONS: boolFromEnv.default('false')
});

export type AppConfig = ReturnType<typeof getConfig>;

export const getConfig = () => {
  const env = envSchema.parse(process.env);
  const symbols = env.SYMBOLS.split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);

  return {
    nodeEnv: env.NODE_ENV,
    http: {
      host: env.HTTP_HOST,
      port: env.HTTP_PORT
    },
    db: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      database: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      ssl: env.DB_SSL
    },
    dashboard: {
      authEnabled: env.DASHBOARD_AUTH_ENABLED ?? env.NODE_ENV === 'production',
      username: env.DASHBOARD_USERNAME,
      password: env.DASHBOARD_PASSWORD
    },
    exchange: {
      id: env.EXCHANGE_ID.toLowerCase(),
      quoteCurrency: env.QUOTE_CURRENCY.toUpperCase(),
      symbols
    },
    trading: {
      mode: env.TRADING_MODE,
      liveTradingLocked: env.LIVE_TRADING_LOCKED,
      paperFeePercent: env.PAPER_FEE_PERCENT
    },
    risk: {
      maxOrderQuote: env.RISK_MAX_ORDER_QUOTE,
      dailyQuoteBudget: env.RISK_DAILY_QUOTE_BUDGET,
      maxDailyLossQuote: env.RISK_MAX_DAILY_LOSS_QUOTE,
      maxOpenPositions: env.RISK_MAX_OPEN_POSITIONS,
      maxSymbolExposureQuote: env.RISK_MAX_SYMBOL_EXPOSURE_QUOTE,
      maxSpreadPercent: env.RISK_MAX_SPREAD_PERCENT
    },
    autoTrader: {
      enabled: env.AUTO_PAPER_TRADER_ENABLED,
      intervalMs: env.AUTO_PAPER_TRADER_INTERVAL_MS,
      orderQuote: env.AUTO_PAPER_ORDER_QUOTE,
      minChangePercent: env.AUTO_PAPER_MIN_24H_CHANGE_PERCENT,
      sellTakeProfitPercent: env.AUTO_PAPER_TAKE_PROFIT_PERCENT,
      sellStopLossPercent: env.AUTO_PAPER_STOP_LOSS_PERCENT,
      allowFallbackMarketData: env.AUTO_PAPER_ALLOW_FALLBACK_MARKET_DATA,
      recordObservations: env.AUTO_PAPER_RECORD_OBSERVATIONS
    }
  } as const;
};
