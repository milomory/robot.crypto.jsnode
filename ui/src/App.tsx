import {
  Activity,
  AlertTriangle,
  Bot,
  BookOpenText,
  CirclePause,
  Database,
  Gauge,
  LockKeyhole,
  Play,
  RefreshCw,
  ShieldCheck,
  WalletCards
} from 'lucide-react';
import { apiUrl } from './api-url';
import { FormEvent, useEffect, useMemo, useState } from 'react';

type StatusPayload = {
  ok: boolean;
  mode: 'paper' | 'live';
  liveTradingLocked: boolean;
  dashboardAuth?: 'enabled' | 'disabled';
  access?: { role: 'viewer' | 'operator' };
  autoTrader?: AutoTraderStatus;
  exchange: string;
  marketData: string;
  database: { ok: boolean; error?: string };
  symbols: string[];
  quoteCurrency: string;
  serverTime: string;
};

type MarketTicker = {
  exchange: string;
  symbol: string;
  bid?: number;
  ask?: number;
  lastPrice: number;
  volume24h?: number;
  quoteVolume24h?: number;
  observedAt: string;
};

type RiskPayload = {
  budget: Record<string, number>;
  usage: {
    dailyBuyQuoteUsage: number;
    realizedPnlQuote: number;
    openPositions: number;
  };
};

type Position = {
  symbol: string;
  baseQuantity: number;
  avgEntryPrice: number;
  realizedPnlQuote: number;
  updatedAt: string;
};

type Trade = {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  quoteValue: number;
  feeQuote: number;
  executedAt: string;
};

type Order = {
  id: string;
  mode: 'paper' | 'live';
  exchange: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  status: string;
  requestedQuantity: number;
  filledQuantity: number;
  avgFillPrice?: number;
  quoteValue?: number;
  feesQuote: number;
  reason?: string;
  createdAt: string;
};

type Decision = {
  id: string;
  symbol: string;
  signal: string;
  decision: 'allow' | 'block' | 'observe';
  reason: string;
  score?: number;
  created_at: string;
};

type RiskEvent = {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  gate: string;
  symbol?: string;
  decision: 'allow' | 'block' | 'observe';
  message: string;
  created_at: string;
};

type AutoTraderSignal = {
  symbol: string;
  action: 'buy' | 'sell' | 'hold' | 'skip';
  decision: 'allow' | 'block' | 'observe';
  reason: string;
  price?: number;
  priceChangePercent24h?: number;
  quoteValue?: number;
};

type AutoTraderStatus = {
  enabled: boolean;
  intervalMs: number;
  orderQuote: number;
  minChangePercent: number;
  sellTakeProfitPercent: number;
  sellStopLossPercent: number;
  lastRunAt?: string;
  nextRunAt?: string;
  lastError?: string;
  consecutiveErrors: number;
  running: boolean;
  lastSignals: AutoTraderSignal[];
};

type AutoTraderFetchResult = {
  status?: AutoTraderStatus;
  error?: string;
};

type Snapshot = {
  status?: StatusPayload;
  autoTrader?: AutoTraderStatus;
  autoTraderError?: string;
  tickers: MarketTicker[];
  risk?: RiskPayload;
  positions: Position[];
  orders: Order[];
  trades: Trade[];
  decisions: Decision[];
  events: RiskEvent[];
  error?: string;
};

const emptySnapshot: Snapshot = {
  tickers: [],
  positions: [],
  orders: [],
  trades: [],
  decisions: [],
  events: []
};

const nav = [
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'paper', label: 'Paper Trading', icon: Play },
  { id: 'journal', label: 'Journal', icon: BookOpenText },
  { id: 'risk', label: 'Risk', icon: ShieldCheck },
  { id: 'logs', label: 'Logs', icon: Activity }
] as const;

type NavId = (typeof nav)[number]['id'];

const formatNumber = (value?: number, digits = 2) =>
  value === undefined || Number.isNaN(value)
    ? 'n/a'
    : new Intl.NumberFormat('en-US', {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits
      }).format(value);

const formatCompact = (value?: number) =>
  value === undefined || Number.isNaN(value)
    ? 'n/a'
    : new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 2
      }).format(value);

const formatTime = (value?: string) => (value ? new Date(value).toLocaleTimeString() : 'n/a');

const formatDateTime = (value?: string) => {
  if (!value) {
    return 'n/a';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const formatPercent = (value?: number, digits = 2) =>
  value === undefined || Number.isNaN(value) ? 'n/a' : `${formatNumber(value, digits)}%`;

const formatInterval = (value?: number) => {
  if (value === undefined || Number.isNaN(value)) {
    return 'n/a';
  }

  if (value < 1_000) {
    return `${value} ms`;
  }

  const seconds = value / 1_000;
  if (seconds < 60) {
    return `${formatNumber(seconds, seconds % 1 === 0 ? 0 : 1)}s`;
  }

  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${formatNumber(minutes, minutes % 1 === 0 ? 0 : 1)}m`;
  }

  const hours = minutes / 60;
  return `${formatNumber(hours, hours % 1 === 0 ? 0 : 1)}h`;
};

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const pageTitle = (active: NavId) => nav.find((item) => item.id === active)?.label ?? 'Overview';


let redirectingToLogin = false;
const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);

  if (typeof init?.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(apiUrl(path, import.meta.env.VITE_API_BASE), {
    ...init,
    headers
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && payload.error === 'not_authenticated' && !redirectingToLogin) {
      redirectingToLogin = true;
      window.location.replace('/auth/login');
    }
    throw new Error(payload.error?.message ?? payload.error ?? `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
};

const fetchAutoTraderStatus = async (): Promise<AutoTraderFetchResult> => {
  try {
    return { status: await api<AutoTraderStatus>('/api/auto-trader/status') };
  } catch (error) {
    return { error: getErrorMessage(error) };
  }
};

function StatusPill({
  tone,
  children
}: {
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  children: React.ReactNode;
}) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function Panel({
  title,
  icon,
  children,
  action
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-header">
        <div className="panel-title">
          {icon}
          <h2>{title}</h2>
        </div>
        {action ? <div className="panel-action">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  tone = 'neutral'
}: {
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function useSnapshot() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [status, market, risk, positions, journal, events, autoTrader] = await Promise.all([
        api<StatusPayload>('/api/status'),
        api<{ tickers: MarketTicker[] }>('/api/market/tickers'),
        api<RiskPayload>('/api/risk-budget'),
        api<{ positions: Position[] }>('/api/positions'),
        api<{ orders: Order[]; trades: Trade[]; decisions: Decision[] }>('/api/journal'),
        api<{ events: RiskEvent[] }>('/api/risk-events'),
        fetchAutoTraderStatus()
      ]);

      setSnapshot({
        status,
        autoTrader: autoTrader.status,
        autoTraderError: autoTrader.error,
        tickers: market.tickers,
        risk,
        positions: positions.positions,
        orders: journal.orders,
        trades: journal.trades,
        decisions: journal.decisions,
        events: events.events
      });
    } catch (error) {
      setSnapshot((current) => ({
        ...current,
        error: getErrorMessage(error)
      }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 15_000);

    return () => window.clearInterval(timer);
  }, []);

  return { snapshot, loading, refresh };
}

function PaperOrderPanel({
  symbols,
  onFilled
}: {
  symbols: string[];
  onFilled: () => void;
}) {
  const [symbol, setSymbol] = useState(symbols[0] ?? 'BTC/USDT');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [quoteValue, setQuoteValue] = useState('25');
  const [baseQuantity, setBaseQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (symbols.length && !symbols.includes(symbol)) {
      setSymbol(symbols[0]);
    }
  }, [symbols, symbol]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');

    try {
      await api('/api/paper/orders', {
        method: 'POST',
        body: JSON.stringify({
          symbol,
          side,
          quoteValue: quoteValue ? Number(quoteValue) : undefined,
          baseQuantity: baseQuantity ? Number(baseQuantity) : undefined,
          reason: 'dashboard paper order'
        })
      });
      setMessage('filled');
      onFilled();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Paper Order" icon={<WalletCards size={16} />}>
      <form className="order-form" onSubmit={submit}>
        <label>
          <span>Symbol</span>
          <select value={symbol} onChange={(event) => setSymbol(event.target.value)}>
            {symbols.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Side</span>
          <div className="segmented">
            <button type="button" className={side === 'buy' ? 'active' : ''} onClick={() => setSide('buy')}>
              Buy
            </button>
            <button type="button" className={side === 'sell' ? 'active' : ''} onClick={() => setSide('sell')}>
              Sell
            </button>
          </div>
        </label>
        <label>
          <span>Quote USDT</span>
          <input value={quoteValue} onChange={(event) => setQuoteValue(event.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>Base qty</span>
          <input
            value={baseQuantity}
            onChange={(event) => setBaseQuantity(event.target.value)}
            inputMode="decimal"
            placeholder="auto"
          />
        </label>
        <button className="primary" disabled={busy} type="submit">
          {busy ? 'Sending' : 'Place paper order'}
        </button>
        {message ? <div className={message === 'filled' ? 'form-message good' : 'form-message bad'}>{message}</div> : null}
      </form>
    </Panel>
  );
}

function DashboardMetrics({
  realized,
  exposure,
  dailyBuyQuoteUsage,
  openPositions
}: {
  realized: number;
  exposure: number;
  dailyBuyQuoteUsage: number;
  openPositions: number;
}) {
  return (
    <section className="metric-grid">
      <Metric label="Realized net P/L" value={`${formatNumber(realized)} USDT`} tone={realized >= 0 ? 'good' : 'bad'} />
      <Metric label="Open exposure" value={`${formatNumber(exposure)} USDT`} />
      <Metric label="Daily buy usage" value={`${formatNumber(dailyBuyQuoteUsage)} USDT`} />
      <Metric label="Open positions" value={String(openPositions)} />
    </section>
  );
}

const actionTone = (action: AutoTraderSignal['action']): 'good' | 'warn' | 'bad' | 'neutral' => {
  if (action === 'buy') {
    return 'good';
  }

  if (action === 'sell') {
    return 'warn';
  }

  return 'neutral';
};

const decisionTone = (decision: AutoTraderSignal['decision']): 'good' | 'warn' | 'bad' | 'neutral' => {
  if (decision === 'allow') {
    return 'good';
  }

  if (decision === 'block') {
    return 'bad';
  }

  return 'neutral';
};

function AutoTraderPanel({
  status,
  statusError,
  canOperate,
  onScanned
}: {
  status?: AutoTraderStatus;
  statusError?: string;
  canOperate: boolean;
  onScanned: () => Promise<void> | void;
}) {
  const [scanState, setScanState] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [scanMessage, setScanMessage] = useState('');
  const signals = status?.lastSignals ?? [];
  const stateLabel = status?.running ? 'running' : status?.enabled ? 'enabled' : status ? 'disabled' : 'waiting';
  const stateTone = status?.running ? 'warn' : status?.enabled ? 'good' : 'neutral';
  const statusRows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: 'Enabled',
      value: status ? <StatusPill tone={status.enabled ? 'good' : 'neutral'}>{String(status.enabled)}</StatusPill> : 'n/a'
    },
    {
      label: 'Running',
      value: status ? <StatusPill tone={status.running ? 'warn' : 'neutral'}>{String(status.running)}</StatusPill> : 'n/a'
    },
    { label: 'Interval', value: formatInterval(status?.intervalMs) },
    { label: 'Order quote', value: formatNumber(status?.orderQuote) },
    { label: 'Min change', value: formatPercent(status?.minChangePercent) },
    { label: 'TP / SL', value: `${formatPercent(status?.sellTakeProfitPercent)} / ${formatPercent(status?.sellStopLossPercent)}` },
    { label: 'Last run', value: formatDateTime(status?.lastRunAt) },
    { label: 'Next run', value: formatDateTime(status?.nextRunAt) },
    { label: 'Errors', value: String(status?.consecutiveErrors ?? 0) }
  ];

  const runScan = async () => {
    setScanState('running');
    setScanMessage('scan running');

    try {
      await api<AutoTraderStatus>('/api/auto-trader/scan', { method: 'POST' });
      await onScanned();
      setScanState('success');
      setScanMessage('scan complete');
    } catch (error) {
      setScanState('error');
      setScanMessage(getErrorMessage(error));
    }
  };

  return (
    <Panel
      title="Auto Trader"
      icon={<Bot size={16} />}
      action={
        <div className="panel-action-row">
          <StatusPill tone={stateTone}>{stateLabel}</StatusPill>
          {canOperate ? <button
            className="primary compact"
            type="button"
            disabled={scanState === 'running'}
            aria-busy={scanState === 'running'}
            onClick={() => void runScan()}
          >
            <RefreshCw size={14} className={scanState === 'running' ? 'spin' : ''} />
            {scanState === 'running' ? 'Running' : 'Run scan'}
          </button> : <StatusPill tone="neutral">Read only</StatusPill>}
        </div>
      }
    >
      <div className="auto-status-grid">
        {statusRows.map((row) => (
          <div className="auto-status-cell" key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>

      {!status && !statusError ? <div className="scan-message neutral">status loading</div> : null}
      {statusError ? <div className="scan-message bad">status: {statusError}</div> : null}
      {status?.lastError ? <div className="scan-message bad">last error: {status.lastError}</div> : null}
      {scanMessage ? <div className={`scan-message ${scanState === 'error' ? 'bad' : scanState}`}>{scanMessage}</div> : null}

      <table className="signals-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Action</th>
            <th>Decision</th>
            <th className="right">24h</th>
            <th className="right">Price</th>
            <th className="right">Quote</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {signals.length ? (
            signals.slice(0, 12).map((signal, index) => {
              const changeClass =
                signal.priceChangePercent24h === undefined
                  ? ''
                  : signal.priceChangePercent24h >= 0
                    ? 'good-text'
                    : 'bad-text';

              return (
                <tr key={`${signal.symbol}-${signal.action}-${signal.decision}-${index}`}>
                  <td>
                    <strong>{signal.symbol}</strong>
                  </td>
                  <td>
                    <StatusPill tone={actionTone(signal.action)}>{signal.action}</StatusPill>
                  </td>
                  <td>
                    <StatusPill tone={decisionTone(signal.decision)}>{signal.decision}</StatusPill>
                  </td>
                  <td className={`right ${changeClass}`}>{formatPercent(signal.priceChangePercent24h)}</td>
                  <td className="right">{formatNumber(signal.price)}</td>
                  <td className="right">{formatNumber(signal.quoteValue)}</td>
                  <td className="reason">{signal.reason}</td>
                </tr>
              );
            })
          ) : (
            <tr>
              <td colSpan={7} className="empty">
                No signals
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function MarketWatchPanel({ tickers }: { tickers: MarketTicker[] }) {
  return (
    <Panel title="Market Watch" icon={<Activity size={16} />}>
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th className="right">Last</th>
            <th className="right">Bid</th>
            <th className="right">Ask</th>
            <th className="right">24h quote</th>
          </tr>
        </thead>
        <tbody>
          {tickers.length ? (
            tickers.map((ticker) => (
              <tr key={ticker.symbol}>
                <td>
                  <strong>{ticker.symbol}</strong>
                  <span className="subline">{ticker.exchange}</span>
                </td>
                <td className="right">{formatNumber(ticker.lastPrice)}</td>
                <td className="right">{formatNumber(ticker.bid)}</td>
                <td className="right">{formatNumber(ticker.ask)}</td>
                <td className="right">{formatCompact(ticker.quoteVolume24h)}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={5} className="empty">
                Waiting for market data
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function RiskBudgetPanel({ risk }: { risk?: RiskPayload }) {
  return (
    <Panel title="Risk Budget" icon={<ShieldCheck size={16} />}>
      <div className="budget-list">
        {risk ? (
          Object.entries(risk.budget).map(([key, value]) => (
            <div key={key} className="budget-row">
              <span>{key}</span>
              <strong>{formatNumber(value)}</strong>
            </div>
          ))
        ) : (
          <div className="empty">Risk budget is loading</div>
        )}
      </div>
    </Panel>
  );
}

function PositionsPanel({ positions }: { positions: Position[] }) {
  return (
    <Panel title="Positions" icon={<WalletCards size={16} />}>
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th className="right">Qty</th>
            <th className="right">Avg</th>
            <th className="right">Realized</th>
          </tr>
        </thead>
        <tbody>
          {positions.length ? (
            positions.map((position) => (
              <tr key={position.symbol}>
                <td>{position.symbol}</td>
                <td className="right">{formatNumber(position.baseQuantity, 8)}</td>
                <td className="right">{formatNumber(position.avgEntryPrice)}</td>
                <td className={`right ${position.realizedPnlQuote >= 0 ? 'good-text' : 'bad-text'}`}>
                  {formatNumber(position.realizedPnlQuote)}
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={4} className="empty">
                No positions
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function TradesPanel({ trades, limit = 12 }: { trades: Trade[]; limit?: number }) {
  return (
    <Panel title="Recent Trades" icon={<BookOpenText size={16} />}>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Symbol</th>
            <th>Side</th>
            <th className="right">Qty</th>
            <th className="right">Quote</th>
            <th className="right">Fee</th>
          </tr>
        </thead>
        <tbody>
          {trades.length ? (
            trades.slice(0, limit).map((trade) => (
              <tr key={trade.id}>
                <td>{formatTime(trade.executedAt)}</td>
                <td>{trade.symbol}</td>
                <td>
                  <StatusPill tone={trade.side === 'buy' ? 'good' : 'warn'}>{trade.side}</StatusPill>
                </td>
                <td className="right">{formatNumber(trade.quantity, 8)}</td>
                <td className="right">{formatNumber(trade.quoteValue)}</td>
                <td className="right">{formatNumber(trade.feeQuote, 4)}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={6} className="empty">
                No trades
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function OrdersPanel({ orders, limit = 12 }: { orders: Order[]; limit?: number }) {
  return (
    <Panel title="Paper Orders" icon={<WalletCards size={16} />}>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Status</th>
            <th className="right">Filled</th>
            <th className="right">Avg</th>
            <th className="right">Quote</th>
          </tr>
        </thead>
        <tbody>
          {orders.length ? (
            orders.slice(0, limit).map((order) => (
              <tr key={order.id}>
                <td>{formatTime(order.createdAt)}</td>
                <td>{order.symbol}</td>
                <td>
                  <StatusPill tone={order.side === 'buy' ? 'good' : 'warn'}>{order.side}</StatusPill>
                </td>
                <td>{order.status}</td>
                <td className="right">{formatNumber(order.filledQuantity, 8)}</td>
                <td className="right">{formatNumber(order.avgFillPrice)}</td>
                <td className="right">{formatNumber(order.quoteValue)}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={7} className="empty">
                No orders
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function DecisionJournalPanel({ decisions }: { decisions: Decision[] }) {
  return (
    <Panel title="Decision Journal" icon={<BookOpenText size={16} />}>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Symbol</th>
            <th>Signal</th>
            <th>Decision</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {decisions.length ? (
            decisions.slice(0, 16).map((decision) => (
              <tr key={decision.id}>
                <td>{formatTime(decision.created_at)}</td>
                <td>{decision.symbol}</td>
                <td>{decision.signal}</td>
                <td>
                  <StatusPill tone={decision.decision === 'allow' ? 'good' : decision.decision === 'block' ? 'bad' : 'neutral'}>
                    {decision.decision}
                  </StatusPill>
                </td>
                <td className="reason">{decision.reason}</td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={5} className="empty">
                No decisions
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function RiskLogPanel({ events, limit = 10 }: { events: RiskEvent[]; limit?: number }) {
  return (
    <Panel
      title="Risk Log"
      icon={<CirclePause size={16} />}
      action={<StatusPill tone={events.some((event) => event.severity === 'critical') ? 'bad' : 'neutral'}>{events.length}</StatusPill>}
    >
      <div className="event-log">
        {events.length ? (
          events.slice(0, limit).map((event) => (
            <div key={event.id} className={`event ${event.severity}`}>
              <span>{formatTime(event.created_at)}</span>
              <strong>{event.gate}</strong>
              <p>{event.message}</p>
            </div>
          ))
        ) : (
          <div className="empty">No risk events</div>
        )}
      </div>
    </Panel>
  );
}

function RuntimePanel({ status }: { status?: StatusPayload }) {
  return (
    <Panel title="Runtime" icon={<Database size={16} />}>
      <div className="budget-list">
        <div className="budget-row">
          <span>mode</span>
          <strong>{status?.mode ?? 'waiting'}</strong>
        </div>
        <div className="budget-row">
          <span>liveTradingLocked</span>
          <strong>{String(status?.liveTradingLocked ?? true)}</strong>
        </div>
        <div className="budget-row">
          <span>dashboardAuth</span>
          <strong>{status?.dashboardAuth ?? 'unknown'}</strong>
        </div>
        <div className="budget-row">
          <span>exchange</span>
          <strong>{status?.exchange ?? 'unknown'}</strong>
        </div>
        <div className="budget-row">
          <span>marketData</span>
          <strong>{status?.marketData ?? 'unknown'}</strong>
        </div>
        <div className="budget-row">
          <span>database</span>
          <strong>{status?.database.ok ? 'ok' : 'error'}</strong>
        </div>
      </div>
    </Panel>
  );
}

export function App() {
  const [active, setActive] = useState<(typeof nav)[number]['id']>('overview');
  const { snapshot, loading, refresh } = useSnapshot();
  const status = snapshot.status;
  const canOperate = !snapshot.error && status?.access?.role === 'operator';
  const symbols = status?.symbols ?? ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  const realized = snapshot.risk?.usage.realizedPnlQuote ?? 0;

  const exposure = useMemo(
    () =>
      snapshot.positions.reduce((sum, position) => {
        const ticker = snapshot.tickers.find((item) => item.symbol === position.symbol);
        return sum + position.baseQuantity * (ticker?.lastPrice ?? position.avgEntryPrice);
      }, 0),
    [snapshot.positions, snapshot.tickers]
  );
  const dailyBuyQuoteUsage = snapshot.risk?.usage.dailyBuyQuoteUsage ?? 0;
  const openPositionCount = snapshot.risk?.usage.openPositions ?? snapshot.positions.length;
  const metrics = (
    <DashboardMetrics
      realized={realized}
      exposure={exposure}
      dailyBuyQuoteUsage={dailyBuyQuoteUsage}
      openPositions={openPositionCount}
    />
  );
  const autoTraderPanel = (
    <AutoTraderPanel
      status={snapshot.autoTrader}
      statusError={snapshot.autoTraderError}
      canOperate={canOperate}
      onScanned={() => refresh()}
    />
  );

  const activeContent = (() => {
    switch (active) {
      case 'paper':
        return (
          <>
            {metrics}
            <section className="grid">{autoTraderPanel}</section>
            <section className="grid two-one">
              {canOperate ? <PaperOrderPanel symbols={symbols} onFilled={() => void refresh()} /> : null}
              <PositionsPanel positions={snapshot.positions} />
            </section>
            <section className="grid equal">
              <OrdersPanel orders={snapshot.orders} />
              <TradesPanel trades={snapshot.trades} limit={10} />
            </section>
          </>
        );
      case 'journal':
        return (
          <section className="page-stack">
            <DecisionJournalPanel decisions={snapshot.decisions} />
            <section className="grid equal">
              <TradesPanel trades={snapshot.trades} limit={20} />
              <OrdersPanel orders={snapshot.orders} limit={20} />
            </section>
          </section>
        );
      case 'risk':
        return (
          <>
            {metrics}
            <section className="grid equal">
              <RiskBudgetPanel risk={snapshot.risk} />
              <RiskLogPanel events={snapshot.events} limit={16} />
            </section>
            <DecisionJournalPanel decisions={snapshot.decisions.filter((decision) => decision.decision !== 'allow')} />
          </>
        );
      case 'logs':
        return (
          <section className="grid equal">
            <RuntimePanel status={status} />
            <RiskLogPanel events={snapshot.events} limit={24} />
          </section>
        );
      case 'overview':
      default:
        return (
          <>
            {metrics}
            <section className="grid two-one">
              <MarketWatchPanel tickers={snapshot.tickers} />
              {autoTraderPanel}
            </section>
            <section className="grid equal">
              {canOperate ? <PaperOrderPanel symbols={symbols} onFilled={() => void refresh()} /> : null}
              <PositionsPanel positions={snapshot.positions} />
            </section>
            <section className="grid">
              <RiskBudgetPanel risk={snapshot.risk} />
            </section>
            <section className="grid equal">
              <TradesPanel trades={snapshot.trades} limit={8} />
              <RiskLogPanel events={snapshot.events} />
            </section>
          </>
        );
    }
  })();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">CR</div>
          <div>
            <strong>Crypto Robot</strong>
            <span>paper ops</span>
          </div>
        </div>
        <nav>
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={active === item.id ? 'active' : ''} onClick={() => setActive(item.id)}>
                <Icon size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <h1>{pageTitle(active)}</h1>
            <span className="timestamp">server {formatTime(status?.serverTime)}</span>
          </div>
          <div className="status-strip">
            <StatusPill tone={status?.mode === 'paper' ? 'good' : 'bad'}>{status?.mode?.toUpperCase() ?? 'WAIT'}</StatusPill>
            <StatusPill tone={status?.liveTradingLocked ? 'good' : 'bad'}>
              <LockKeyhole size={12} /> live locked
            </StatusPill>
            <StatusPill tone={status?.database.ok ? 'good' : 'bad'}>
              <Database size={12} /> postgres
            </StatusPill>
            <button className="icon-button" onClick={() => void refresh()} disabled={loading} title="Refresh">
              <RefreshCw size={16} />
            </button>
          </div>
        </header>

        {snapshot.error ? (
          <div className="alert-row">
            <AlertTriangle size={16} />
            {snapshot.error}
          </div>
        ) : null}

        {activeContent}
      </main>
    </div>
  );
}
