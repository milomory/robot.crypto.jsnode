export type TradingMode = 'paper' | 'live';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type RiskDecisionType = 'allow' | 'block' | 'observe';
export type RiskSeverity = 'info' | 'warning' | 'critical';

export interface MarketTicker {
  exchange: string;
  symbol: string;
  bid?: number;
  ask?: number;
  lastPrice: number;
  priceChangePercent24h?: number;
  volume24h?: number;
  quoteVolume24h?: number;
  observedAt: Date;
}

export interface PaperOrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  baseQuantity: number;
  reason: string;
}

export interface OrderRecord {
  id: string;
  mode: TradingMode;
  exchange: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: string;
  requestedQuantity: number;
  filledQuantity: number;
  limitPrice?: number;
  avgFillPrice?: number;
  quoteValue?: number;
  feesQuote: number;
  clientOrderId: string;
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TradeRecord {
  id: string;
  orderId: string;
  mode: TradingMode;
  exchange: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;
  quoteValue: number;
  feeQuote: number;
  executedAt: Date;
}

export interface PositionRecord {
  symbol: string;
  baseQuantity: number;
  avgEntryPrice: number;
  realizedPnlQuote: number;
  updatedAt: Date;
}

export interface RiskBudget {
  maxOrderQuote: number;
  dailyQuoteBudget: number;
  maxDailyLossQuote: number;
  maxOpenPositions: number;
  maxSymbolExposureQuote: number;
  maxSpreadPercent: number;
}

export interface RiskEventInput {
  severity: RiskSeverity;
  gate: string;
  symbol?: string;
  decision: RiskDecisionType;
  message: string;
  context?: Record<string, unknown>;
}

export interface RiskDecision {
  decision: RiskDecisionType;
  events: RiskEventInput[];
}

export interface RiskContext {
  mode: TradingMode;
  liveTradingLocked: boolean;
  allowedSymbols: string[];
  dailyBuyQuoteUsage: number;
  realizedPnlQuote: number;
  openPositions: PositionRecord[];
  ticker: MarketTicker;
  budget: RiskBudget;
}
