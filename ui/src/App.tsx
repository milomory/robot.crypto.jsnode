import {
  Activity,
  AlertTriangle,
  Bot,
  BookOpenText,
  CirclePause,
  Database,
  FlaskConical,
  Gauge,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  WalletCards
} from 'lucide-react';
import { apiUrl } from './api-url';
import { AccountDashboard, useAccountDashboard, type AccountPage } from './AccountDashboard';
import { LabReport, type Payload as LabPayload } from './LabReport';
import { LiveReadiness } from './LiveReadiness';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type StatusPayload = {
  ok: boolean;
  mode: 'paper' | 'live';
  liveTradingLocked: boolean;
  dashboardAuth?: 'enabled' | 'disabled';
  access?: { role: 'viewer' | 'operator'; accountOwner?: boolean };
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
  mode: 'paper' | 'live';
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
  { id: 'overview', label: 'Главная', icon: Gauge },
  { id: 'exchanges', label: 'Биржи', icon: WalletCards },
  { id: 'earn', label: 'Earn', icon: WalletCards },
  { id: 'operations', label: 'История бирж', icon: BookOpenText },
  { id: 'paper', label: 'Симулятор', icon: FlaskConical },
  { id: 'live', label: 'Реальный робот', icon: Bot },
  { id: 'lab', label: 'Наблюдения', icon: FlaskConical },
  { id: 'risk', label: 'Риски', icon: ShieldCheck },
  { id: 'logs', label: 'Состояние и логи', icon: Activity }
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

const pageTitle = (active: NavId) => nav.find((item) => item.id === active)?.label ?? 'Главная';


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

const loadLabReport = () => api<LabPayload>('/api/lab/report');

const fetchAutoTraderStatus = async (signal?: AbortSignal): Promise<AutoTraderFetchResult> => {
  try {
    return { status: await api<AutoTraderStatus>('/api/auto-trader/status', { signal }) };
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
  const inFlight = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setLoading(true);
    const deadline = window.setTimeout(() => controller.abort(), 10_000);
    const live = () => inFlight.current === controller && !controller.signal.aborted;
    try {
      await Promise.all([
        // Owner authorization is independent of paper data availability.
        api<StatusPayload>('/api/status', { signal: controller.signal }).then(status => {
          if (live()) setSnapshot(current => ({ ...current, status }));
        }).catch(() => {
          if (inFlight.current === controller) setSnapshot(current => ({ ...current, status: undefined }));
        }),
        Promise.all([
          api<{ tickers: MarketTicker[] }>('/api/market/tickers', { signal: controller.signal }),
          api<RiskPayload>('/api/risk-budget', { signal: controller.signal }),
          api<{ positions: Position[] }>('/api/positions', { signal: controller.signal }),
          api<{ orders: Order[]; trades: Trade[]; decisions: Decision[] }>('/api/journal', { signal: controller.signal }),
          api<{ events: RiskEvent[] }>('/api/risk-events', { signal: controller.signal }),
          fetchAutoTraderStatus(controller.signal)
        ]).then(([market, risk, positions, journal, events, autoTrader]) => {
          if (live()) setSnapshot(current => ({ ...current, tickers: market.tickers, risk,
            positions: positions.positions, orders: journal.orders.filter(order => order.mode === 'paper'),
            trades: journal.trades.filter(trade => trade.mode === 'paper'),
            decisions: journal.decisions, events: events.events,
            autoTrader: autoTrader.status, autoTraderError: autoTrader.error, error: undefined }));
        }).catch(error => {
          if (inFlight.current === controller) setSnapshot(current => ({ ...current, error: getErrorMessage(error) }));
        })
      ]);
    } finally {
      window.clearTimeout(deadline);
      controller.abort();
      if (inFlight.current === controller) { inFlight.current = null; setLoading(false); }
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      window.clearInterval(timer);
      const controller = inFlight.current;
      inFlight.current = null;
      controller?.abort();
    };
  }, [refresh]);
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
    <Panel title="Виртуальная заявка" icon={<WalletCards size={16} />}>
      <form className="order-form" onSubmit={submit}>
        <label>
          <span>Пара</span>
          <select value={symbol} onChange={(event) => setSymbol(event.target.value)}>
            {symbols.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Направление</span>
          <div className="segmented">
            <button type="button" className={side === 'buy' ? 'active' : ''} onClick={() => setSide('buy')}>
              Купить
            </button>
            <button type="button" className={side === 'sell' ? 'active' : ''} onClick={() => setSide('sell')}>
              Продать
            </button>
          </div>
        </label>
        <label>
          <span>Виртуальная сумма, USDT</span>
          <input value={quoteValue} onChange={(event) => setQuoteValue(event.target.value)} inputMode="decimal" />
        </label>
        <label>
          <span>Виртуальное количество актива</span>
          <input
            value={baseQuantity}
            onChange={(event) => setBaseQuantity(event.target.value)}
            inputMode="decimal"
            placeholder="auto"
          />
        </label>
        <button className="primary" disabled={busy} type="submit">
          {busy ? 'Выполняем в симуляторе' : 'Создать виртуальную заявку'}
        </button>
        {message ? <div className={message === 'filled' ? 'form-message good' : 'form-message bad'}>{message === 'filled' ? 'Виртуальная заявка исполнена в симуляторе' : message}</div> : null}
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
      <Metric label="Виртуальный результат" value={`${formatNumber(realized)} USDT`} tone={realized >= 0 ? 'good' : 'bad'} />
      <Metric label="Виртуальные активы" value={`${formatNumber(exposure)} USDT`} />
      <Metric label="Виртуальные покупки за день" value={`${formatNumber(dailyBuyQuoteUsage)} USDT`} />
      <Metric label="Виртуальные позиции" value={String(openPositions)} />
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
  const stateLabel = status?.running ? 'Выполняется цикл' : status?.enabled ? 'Включён' : status ? 'Выключен' : 'Нет данных';
  const stateTone = status?.running ? 'warn' : status?.enabled ? 'good' : 'neutral';
  const statusRows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: 'Автоматические циклы',
      value: status ? <StatusPill tone={status.enabled ? 'good' : 'neutral'}>{status.enabled ? 'Включены' : 'Выключены'}</StatusPill> : 'n/a'
    },
    {
      label: 'Текущий цикл',
      value: status ? <StatusPill tone={status.running ? 'warn' : 'neutral'}>{status.running ? 'Выполняется' : 'Ожидает'}</StatusPill> : 'n/a'
    },
    { label: 'Интервал', value: formatInterval(status?.intervalMs) },
    { label: 'Виртуальная заявка, USDT', value: formatNumber(status?.orderQuote) },
    { label: 'Мин. изменение цены', value: formatPercent(status?.minChangePercent) },
    { label: 'TP / SL', value: `${formatPercent(status?.sellTakeProfitPercent)} / ${formatPercent(status?.sellStopLossPercent)}` },
    { label: 'Последний цикл', value: formatDateTime(status?.lastRunAt) },
    { label: 'Следующий цикл', value: formatDateTime(status?.nextRunAt) },
    { label: 'Ошибки', value: String(status?.consecutiveErrors ?? 0) }
  ];

  const runScan = async () => {
    setScanState('running');
    setScanMessage('Выполняется цикл симулятора');

    try {
      await api<AutoTraderStatus>('/api/auto-trader/scan', { method: 'POST' });
      await onScanned();
      setScanState('success');
      setScanMessage('Цикл симулятора завершён');
    } catch (error) {
      setScanState('error');
      setScanMessage(getErrorMessage(error));
    }
  };

  return (
    <Panel
      title="Симулятор робота"
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
            {scanState === 'running' ? 'Проверяем' : 'Запустить цикл симулятора'}
          </button> : <StatusPill tone="neutral">Только чтение</StatusPill>}
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

      {!status && !statusError ? <div className="scan-message neutral">Загружаем состояние симулятора</div> : null}
      {statusError ? <div className="scan-message bad">Состояние симулятора: {statusError}</div> : null}
      {status?.lastError ? <div className="scan-message bad">Последняя ошибка симулятора: {status.lastError}</div> : null}
      {scanMessage ? <div className={`scan-message ${scanState === 'error' ? 'bad' : scanState}`}>{scanMessage}</div> : null}

      <table className="signals-table">
        <thead>
          <tr>
            <th>Пара</th>
            <th>Действие</th>
            <th>Решение</th>
            <th className="right">24h</th>
            <th className="right">Цена</th>
            <th className="right">Сумма</th>
            <th>Причина</th>
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
                Нет сигналов
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
    <Panel title="Рыночные котировки" icon={<Activity size={16} />}>
      <table>
        <thead>
          <tr>
            <th>Пара</th>
            <th className="right">Цена</th>
            <th className="right">Покупка</th>
            <th className="right">Продажа</th>
            <th className="right">Объём за 24 ч</th>
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
                Ожидаем котировки
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
    <Panel title="Лимиты симулятора" icon={<ShieldCheck size={16} />}>
      <div className="budget-list">
        {risk ? (
          Object.entries(risk.budget).map(([key, value]) => (
            <div key={key} className="budget-row">
              <span>{key}</span>
              <strong>{formatNumber(value)}</strong>
            </div>
          ))
        ) : (
          <div className="empty">Загружаем лимиты</div>
        )}
      </div>
    </Panel>
  );
}

function PositionsPanel({ positions }: { positions: Position[] }) {
  return (
    <Panel title="Виртуальные позиции" icon={<WalletCards size={16} />}>
      <table>
        <thead>
          <tr>
            <th>Пара</th>
            <th className="right">Количество</th>
            <th className="right">Средняя цена</th>
            <th className="right">Результат</th>
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
                Нет виртуальных позиций
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
    <Panel title="Виртуальные сделки" icon={<BookOpenText size={16} />}>
      <table>
        <thead>
          <tr>
            <th>Время</th>
            <th>Пара</th>
            <th>Направление</th>
            <th className="right">Количество</th>
            <th className="right">Сумма</th>
            <th className="right">Комиссия</th>
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
                Нет виртуальных сделок
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
    <Panel title="Виртуальные заявки" icon={<WalletCards size={16} />}>
      <table>
        <thead>
          <tr>
            <th>Время</th>
            <th>Пара</th>
            <th>Направление</th>
            <th>Статус</th>
            <th className="right">Исполнено</th>
            <th className="right">Средняя цена</th>
            <th className="right">Сумма</th>
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
                Нет виртуальных заявок
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
    <Panel title="Решения симулятора" icon={<BookOpenText size={16} />}>
      <table>
        <thead>
          <tr>
            <th>Время</th>
            <th>Пара</th>
            <th>Сигнал</th>
            <th>Решение</th>
            <th>Причина</th>
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
                Нет решений
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
      title="События риска"
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
          <div className="empty">Нет событий риска</div>
        )}
      </div>
    </Panel>
  );
}

function RuntimePanel({ status }: { status?: StatusPayload }) {
  return (
    <Panel title="Состояние сервиса" icon={<Database size={16} />}>
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

function SimulatorNotice() {
  return <section className="simulator-notice" aria-label="Режим симулятора">
    <FlaskConical size={21} aria-hidden="true" />
    <div><strong>Симулятор · виртуальные деньги</strong>
      <p>Робот моделирует покупки и продажи по рыночным котировкам. Сделки, позиции и результат на этом экране виртуальные. Деньги на биржах не используются.</p>
    </div>
  </section>;
}

export function App() {
  const [active, setActive] = useState<NavId>('overview');
  const { snapshot, loading, refresh } = useSnapshot();
  const status = snapshot.status;
  const accountOwner = status?.access?.accountOwner === true;
  const accounts = useAccountDashboard(accountOwner);
  const canOperate = !snapshot.error && status?.access?.role === 'operator';
  const symbols = status?.symbols ?? ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'];
  const realized = snapshot.risk?.usage.realizedPnlQuote ?? 0;
  const view = !accountOwner && (active === 'exchanges' || active === 'operations' || active === 'earn') ? 'overview' : active;
  const accountView = accountOwner && ['overview', 'exchanges', 'operations', 'earn'].includes(view);
  const exposure = useMemo(() => snapshot.positions.reduce((sum, position) => {
    const ticker = snapshot.tickers.find(item => item.symbol === position.symbol);
    return sum + position.baseQuantity * (ticker?.lastPrice ?? position.avgEntryPrice);
  }, 0), [snapshot.positions, snapshot.tickers]);
  const metrics = <DashboardMetrics realized={realized} exposure={exposure}
    dailyBuyQuoteUsage={snapshot.risk?.usage.dailyBuyQuoteUsage ?? 0}
    openPositions={snapshot.risk?.usage.openPositions ?? snapshot.positions.length} />;
  const autoTraderPanel = <AutoTraderPanel status={snapshot.autoTrader} statusError={snapshot.autoTraderError}
    canOperate={canOperate} onScanned={() => refresh()} />;
  const paperContent = <>
    <SimulatorNotice />
    {metrics}
    <section className="grid equal"><PositionsPanel positions={snapshot.positions} /><TradesPanel trades={snapshot.trades} limit={12} /></section>
    <details className="paper-details"><summary>Управление симулятором</summary><section className="grid">{autoTraderPanel}</section>{canOperate ? <PaperOrderPanel symbols={symbols} onFilled={() => void refresh()} /> : null}</details>
    <details className="paper-details"><summary>Виртуальные заявки и решения</summary><section className="page-stack"><OrdersPanel orders={snapshot.orders} limit={20} /><DecisionJournalPanel decisions={snapshot.decisions} /></section></details>
  </>;
  const activeContent = (() => {
    if (accountView) return <AccountDashboard page={view as AccountPage} state={accounts} onNavigate={setActive} />;
    switch (view) {
      case 'lab': return <LabReport load={loadLabReport} />;
      case 'paper': return paperContent;
      case 'live': return <LiveReadiness status={status} />;
      case 'risk': return <><p className="paper-notice">Диагностика симулятора · виртуальные средства</p><section className="grid equal"><RiskBudgetPanel risk={snapshot.risk} /><RiskLogPanel events={snapshot.events} limit={16} /></section><DecisionJournalPanel decisions={snapshot.decisions.filter(decision => decision.decision !== 'allow')} /></>;
      case 'logs': return <section className="grid equal"><RuntimePanel status={status} /><RiskLogPanel events={snapshot.events} limit={24} /></section>;
      default: return <><SimulatorNotice /><p className="paper-notice">Реальные счета доступны их владельцу в разделах «Главная», «Биржи» и «История бирж».</p>{metrics}<section className="grid equal"><PositionsPanel positions={snapshot.positions} /><TradesPanel trades={snapshot.trades} limit={8} /></section><details className="paper-details"><summary>Рыночные котировки</summary><MarketWatchPanel tickers={snapshot.tickers} /></details></>;
    }
  })();
  const navButton = (item: (typeof nav)[number]) => {
    const Icon = item.icon;
    return <button key={item.id} type="button" aria-current={view === item.id ? 'page' : undefined}
      className={view === item.id ? 'active' : ''} onClick={() => setActive(item.id)}><Icon size={17} aria-hidden="true" /><span>{item.label}</span></button>;
  };
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark">CR</div><div><strong>Crypto Robot</strong><span>Счета и наблюдение</span></div></div>
      <nav aria-label="Основная навигация">{nav.filter(item => ['overview', 'paper', 'live'].includes(item.id) || (accountOwner && ['exchanges', 'operations', 'earn'].includes(item.id))).map(navButton)}</nav>
      <details className="nav-diagnostics"><summary>Диагностика</summary><nav aria-label="Диагностика">{nav.filter(item => ['risk', 'logs', 'lab'].includes(item.id)).map(navButton)}</nav></details>
    </aside>
    <main><header className="topbar"><div><h1>{view === 'overview' && !accountOwner ? 'Симулятор' : pageTitle(view)}</h1><span className="timestamp">{accountView ? 'Реальные счета · MEXC и OKX' : view === 'live' ? 'Реальные средства · подготовка к запуску' : 'Симулятор · виртуальные средства'}</span></div><div className="status-strip">{!accountView ? <><StatusPill tone={status?.liveTradingLocked === true ? 'neutral' : 'warn'}><LockKeyhole size={12} />{status?.liveTradingLocked === true ? 'Реальная торговля выключена' : 'Статус торговли на уточнении'}</StatusPill><button className="icon-button" onClick={() => void refresh()} disabled={loading} title="Обновить данные робота" aria-label="Обновить данные робота"><RefreshCw size={16} /></button></> : null}</div></header>
      {snapshot.error ? <div className="alert-row" role="alert"><AlertTriangle size={16} />Не удалось обновить данные робота. Повторите обновление.</div> : null}
      {activeContent}
    </main>
  </div>;
}
