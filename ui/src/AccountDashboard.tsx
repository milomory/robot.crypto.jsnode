import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, RefreshCw, WalletCards } from 'lucide-react';
import type { AccountDashboard as DashboardPayload, DashboardExchange, DashboardOperation, DashboardCoverage } from '../../src/accounts/dashboard-contract';
import { apiUrl } from './api-url';
import { BalanceHistory } from './BalanceHistory';
import { EarnPanel, validEarn } from './EarnPanel';
import './AccountOperationSummary.css';

export type AccountPage = 'overview' | 'exchanges' | 'operations' | 'earn';
type LoadState = { data: DashboardPayload | null; loading: boolean; error: 'network' | 'session' | 'forbidden' | null };
const initial: LoadState = { data: null, loading: false, error: null };
const MAX_AGE = 10 * 60_000;
const decimal = /^-?(?:0|[1-9]\d{0,89})(?:\.\d{1,60})?$/;
const amount = (value: unknown): value is string | null => value === null || (typeof value === 'string' && decimal.test(value));
const stamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// The server owns the full schema. This display boundary also refuses malformed
// fields instead of rendering an unchecked response or arbitrary upstream text.
function dashboard(value: unknown): value is DashboardPayload {
  if (!object(value) || value.schema !== 1 || !stamp(value.observedAt) || !['ready', 'partial', 'stale', 'unavailable'].includes(String(value.status)) || value.liveExecutionEnabled !== false || !object(value.totals) || !object(value.operations) || !Array.isArray(value.exchanges) || value.exchanges.length !== 2) return false;
  if (value.earn !== undefined && !validEarn(value.earn)) return false;
  const amounts = ['portfolioUsdt', 'pricedUsdt', 'usdtBalance', 'availableUsdt'];
  if (!amounts.every(key => amount((value.totals as Record<string, unknown>)[key])) || typeof value.totals.valuationComplete !== 'boolean') return false;
  if (!['not-connected', 'available', 'partial', 'error'].includes(String(value.operations.status)) || !Array.isArray(value.operations.items) || value.operations.items.length > 500 || typeof value.operations.coverageLabel !== 'string') return false;
  for (const item of value.operations.items) {
    if (!object(item) || typeof item.id !== 'string' || !['mexc', 'okx'].includes(String(item.venue)) || !['trade', 'deposit', 'withdrawal', 'order'].includes(String(item.type)) || (item.symbol !== null && typeof item.symbol !== 'string') || typeof item.asset !== 'string' || (item.side !== null && !['buy', 'sell'].includes(String(item.side))) || typeof item.amount !== 'string' || !decimal.test(item.amount) || !amount(item.quoteAmount) || !amount(item.fee) || (item.feeAsset !== null && typeof item.feeAsset !== 'string') || !['pending', 'completed', 'cancelled', 'failed', 'partial', 'unknown'].includes(String(item.status)) || !stamp(item.at) || typeof item.isOpen !== 'boolean') return false;
  }
  const venues = new Set();
  for (const exchange of value.exchanges) {
    if (!object(exchange) || !['mexc', 'okx'].includes(String(exchange.venue)) || venues.has(exchange.venue) || !['connected', 'error', 'stale'].includes(String(exchange.status)) || (exchange.observedAt !== null && !stamp(exchange.observedAt)) || !amounts.every(key => amount(exchange[key])) || typeof exchange.valuationComplete !== 'boolean' || !Array.isArray(exchange.unpricedAssets) || !exchange.unpricedAssets.every(item => typeof item === 'string') || !Array.isArray(exchange.assets) || exchange.assets.length > 7000) return false;
    if (exchange.coverage !== undefined) {
      const coverage = exchange.coverage;
      if (!object(coverage) || !['mexc-spot', 'mexc-spot-futures', 'okx-trading-funding', 'okx-account-total'].includes(String(coverage.basis)) ||
        !String(coverage.basis).startsWith(exchange.venue + '-') || !['complete', 'partial'].includes(String(coverage.status)) ||
        coverage.scope !== 'current-account' || !['spot', 'trading-funding'].includes(String(coverage.assetBreakdown)) ||
        (coverage.breakdownMatchesTotal !== undefined && typeof coverage.breakdownMatchesTotal !== 'boolean') ||
        !Array.isArray(coverage.wallets) || coverage.wallets.length < 1 || coverage.wallets.length > 6) return false;
      const ids = new Set();
      for (const wallet of coverage.wallets) {
        if (!object(wallet) || !(exchange.venue === 'mexc' ? ['spot', 'futures', 'earn'] : ['trading', 'funding', 'earn', 'classic']).includes(String(wallet.id)) ||
          ids.has(wallet.id) || !['included', 'unavailable', 'unsupported'].includes(String(wallet.status)) || !amount(wallet.valueUsdt) ||
          (wallet.status !== 'included' && wallet.valueUsdt !== null) || (coverage.status === 'complete' && wallet.status !== 'included') ||
          (wallet.reason !== undefined && !['read-failed', 'unsupported', 'ambiguous-equity', 'unpriced'].includes(String(wallet.reason)))) return false;
        ids.add(wallet.id);
      }
    }
    venues.add(exchange.venue);
    for (const asset of exchange.assets) {
      if (!object(asset) || typeof asset.currency !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(asset.currency) || typeof asset.total !== 'string' || !decimal.test(asset.total) || !['available', 'locked', 'valueUsdt'].every(key => amount(asset[key]))) return false;
    }
  }
  return true;
}

export function useAccountDashboard(allowed: boolean) {
  const [state, setState] = useState<LoadState>(initial);
  const active = useRef<AbortController | null>(null);
  const enabled = useRef(allowed);
  enabled.current = allowed;
  const refresh = useCallback(async () => {
    if (!enabled.current || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setState(current => ({ ...current, loading: true }));
    const deadline = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(apiUrl('/api/accounts/dashboard', import.meta.env.VITE_API_BASE), {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal
      });
      if (active.current !== controller || !enabled.current) return;
      if (controller.signal.aborted) throw new Error();
      if (response.status === 401 || response.status === 403) {
        setState({ data: null, loading: false, error: response.status === 401 ? 'session' : 'forbidden' });
        return;
      }
      if (!response.ok) throw new Error();
      const data: unknown = await response.json();
      if (controller.signal.aborted || !dashboard(data)) throw new Error();
      if (active.current === controller && enabled.current) setState({ data, loading: false, error: null });
    } catch {
      if (active.current === controller && enabled.current) setState({ data: null, loading: false, error: 'network' });
    } finally {
      window.clearTimeout(deadline);
      if (active.current === controller) active.current = null;
    }
  }, []);
  useEffect(() => {
    setState(initial);
    if (!allowed) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      window.clearInterval(timer);
      const controller = active.current;
      active.current = null;
      controller?.abort();
    };
  }, [allowed, refresh]);
  return { ...(allowed ? state : initial), refresh };
}
export type DashboardLoad = ReturnType<typeof useAccountDashboard>;

// Round decimal strings for display without converting account balances to Number.
function formatAmount(value: string | null | undefined, digits = 2, fixed = true): string {
  if (value == null || !decimal.test(value)) return '—';
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const factor = 10n ** BigInt(digits);
  let units = BigInt(whole) * factor + BigInt((fraction + '0'.repeat(digits)).slice(0, digits) || '0');
  if ((fraction[digits] ?? '0') >= '5') units += 1n;
  const integer = (units / factor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  const fractional = (units % factor).toString().padStart(digits, '0');
  const shownFraction = fixed ? fractional : fractional.replace(/0+$/, '');
  return `${negative && units > 0n ? '−' : ''}${integer}${shownFraction ? ',' + shownFraction : ''}`;
}
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'нет снимка';
const isCurrent = (data: DashboardPayload) => data.status !== 'stale' && Date.now() - data.observedAt <= MAX_AGE && data.observedAt <= Date.now() + 60_000;
const exchangeCurrent = (exchange: DashboardExchange, current: boolean) => current && exchange.status === 'connected' && exchange.observedAt !== null && Date.now() - exchange.observedAt <= MAX_AGE;

function StateNotice({ state }: { state: DashboardLoad }) {
  if (state.error === 'session') return <div className="account-empty" role="alert"><strong>Сессия истекла</strong><p>Войдите снова, чтобы увидеть счета.</p><a className="account-link" href="/auth/login">Войти через Auth</a></div>;
  if (state.error === 'forbidden') return <div className="account-empty" role="alert"><strong>Доступ к счетам ограничен</strong><p>Балансы доступны только владельцу аккаунтов.</p></div>;
  if (state.error) return <div className="account-empty" role="alert"><strong>Не удалось обновить счета</strong><p>Проверьте соединение и повторите чтение данных.</p><button className="account-link" onClick={() => void state.refresh()} disabled={state.loading}>Повторить</button></div>;
  return <div className="account-empty" role="status"><strong>Загружаем счета</strong><p>Получаем последний снимок MEXC и OKX.</p></div>;
}

const walletNames: Record<DashboardCoverage['wallets'][number]['id'], string> = {
  spot: 'Spot', futures: 'Futures', trading: 'Trading', funding: 'Funding', earn: 'Earn', classic: 'Classic'
};
const walletName = (exchange: DashboardExchange, id: DashboardCoverage['wallets'][number]['id']) =>
  exchange.venue === 'mexc' && id === 'earn' ? 'Другие Earn-продукты' : walletNames[id];
const assetScope = (exchange: DashboardExchange) => exchange.venue === 'mexc' ? 'Spot' : 'Trading и Funding';
function scopeSummary(exchange: DashboardExchange): string {
  if (exchange.coverage?.basis === 'okx-account-total') return 'OKX: оценка биржи, включая Earn';
  if (exchange.venue === 'okx') return 'OKX: только Trading и Funding';
  return exchange.coverage?.basis === 'mexc-spot-futures' ? 'MEXC: Spot и Futures' : 'MEXC: только Spot';
}
function WalletCoverage({ exchange, current }: { exchange: DashboardExchange; current: boolean }) {
  const coverage = exchange.coverage;
  const fresh = exchangeCurrent(exchange, current);
  if (!coverage) return <div className="account-wallet-coverage"><h3>Охват кошельков</h3><p>{scopeSummary(exchange)}. Остальные кошельки в этом снимке не проверены.</p></div>;
  return <div className="account-wallet-coverage">
    <div className="account-wallet-heading"><h3>Кошельки</h3><span className={coverage.status === 'partial' ? 'partial' : ''}>{coverage.status === 'partial' ? 'Охват неполный' : 'Текущий аккаунт'}</span></div>
    <dl>{coverage.wallets.map(wallet => <div key={wallet.id}>
      <dt>{walletName(exchange, wallet.id)}<span>{wallet.reason === 'ambiguous-equity' ? 'Нельзя достоверно учесть' : wallet.reason === 'unpriced' ? 'Не все активы оценены' : wallet.status === 'unsupported' ? 'Не подключён' : wallet.status === 'unavailable' ? 'Не удалось получить' : fresh ? 'Учтён в оценке' : 'Снимок устарел'}</span></dt>
      <dd title={fresh && wallet.status === 'included' ? wallet.valueUsdt ?? undefined : undefined}>{formatAmount(fresh && wallet.status === 'included' ? wallet.valueUsdt : null)}<span> USDT</span></dd>
    </div>)}</dl>
    {coverage.basis === 'okx-account-total' ? <p>Общий баланс — оценка OKX в USDT, включая Earn. Суммы кошельков приведены отдельно.</p> : null}
    {coverage.breakdownMatchesTotal === false ? <p className="account-wallet-discrepancy">Расшифровка кошельков отличается от общего значения OKX. Для баланса используется общая оценка биржи.</p> : null}
    {coverage.status === 'partial' ? <p>Не подключённые и недоступные кошельки в учтённый баланс не входят.</p> : null}
    {exchange.venue === 'mexc' ? <p>Hold and Earn входит в Spot; Futures Earn — во Futures. Другие продукты Earn и субаккаунты не подтверждены API.</p> : null}
  </div>;
}
function ExchangeRow({ exchange, current, onOpen }: { exchange: DashboardExchange; current: boolean; onOpen?: () => void }) {
  const fresh = exchangeCurrent(exchange, current);
  const status = fresh ? 'Подключена' : exchange.status === 'error' ? 'Нет данных' : 'Данные устарели';
  const value = fresh ? exchange.valuationComplete ? exchange.portfolioUsdt : exchange.pricedUsdt : null;
  const partialScope = exchange.coverage?.status !== 'complete';
  const earn = exchange.coverage?.wallets.find(wallet => wallet.id === 'earn');
  const valueLabel = partialScope ? 'Учтённая часть' : exchange.coverage?.basis === 'okx-account-total' ? 'Оценка биржи' : 'Стоимость активов';
  return <article className="exchange-row">
    <div className="exchange-identity"><span className={`venue-mark ${exchange.venue}`}>{exchange.venue === 'mexc' ? 'M' : 'O'}</span><div><h3>{exchange.venue.toUpperCase()}</h3><span className={`connection-state ${fresh ? 'connected' : 'waiting'}`}><span aria-hidden="true" />{status}</span></div></div>
    <div className="exchange-values"><span>{fresh && !exchange.valuationComplete ? 'Оценённая часть' : valueLabel}</span><strong title={value ?? undefined}>{formatAmount(value)} <small>USDT</small></strong><span>Доступно, {assetScope(exchange)}: {formatAmount(fresh ? exchange.availableUsdt : null)}</span></div>
    <div className="exchange-coverage-note"><span>{scopeSummary(exchange)}{partialScope ? ' · Охват неполный' : ''}</span>{earn ? <span>{earn.status === 'included' ? `${walletName(exchange, 'earn')} в оценке: ${formatAmount(fresh ? earn.valueUsdt : null)} USDT` : earn.status === 'unavailable' ? `${walletName(exchange, 'earn')}: нет данных` : `${walletName(exchange, 'earn')}: не подключены`}</span> : null}</div>
    <div className="exchange-meta"><span>Снимок: {time(exchange.observedAt)}</span>{onOpen ? <button className="account-link" onClick={onOpen}>Кошельки и активы <ArrowRight size={15} /></button> : null}</div>
  </article>;
}

const operationStatus: Record<DashboardOperation['status'], string> = {
  pending: 'В процессе', completed: 'Завершена', cancelled: 'Отменена', failed: 'Ошибка', partial: 'Частично исполнена', unknown: 'На уточнении'
};
function operationLabel(item: DashboardOperation): string {
  if (item.type === 'deposit') return 'Пополнение';
  if (item.type === 'withdrawal') return 'Вывод';
  if (item.type === 'order') return item.side === 'buy' ? 'Заявка на покупку' : item.side === 'sell' ? 'Заявка на продажу' : 'Заявка';
  return item.side === 'buy' ? 'Покупка' : item.side === 'sell' ? 'Продажа' : 'Сделка';
}
type OperationFilter = 'all' | 'open' | 'pending' | 'history';
const openOrder = (item: DashboardOperation) => item.type === 'order' && item.isOpen;
const pendingTransfer = (item: DashboardOperation) => (item.type === 'deposit' || item.type === 'withdrawal') && item.status === 'pending';
const completedOperation = (item: DashboardOperation) => ['completed', 'cancelled', 'failed'].includes(item.status) && !item.isOpen;

function OperationSummary({ data, onOpen }: { data: DashboardPayload; onOpen: (filter: OperationFilter) => void }) {
  const readable = data.operations.status === 'available' || data.operations.status === 'partial';
  const open = readable ? data.operations.items.filter(openOrder).length : null;
  const pending = readable ? data.operations.items.filter(pendingTransfer).length : null;
  const uncertain = readable && data.operations.items.some(item => item.status === 'unknown');
  return <section className="account-operation-summary" aria-label="Незавершённые операции в снимке">
    <div className="operation-counts">
      <button type="button" onClick={() => onOpen('open')} disabled={!readable}><span>Открытые заявки</span><strong>{open ?? '—'}</strong></button>
      <button type="button" onClick={() => onOpen('pending')} disabled={!readable}><span>Вводы и выводы в процессе</span><strong>{pending ?? '—'}</strong></button>
    </div>
    <p>{!readable ? 'Данные об операциях недоступны.' : `В полученных данных${data.operations.status === 'partial' ? ' · охват неполный' : ''}${!isCurrent(data) ? ' · на момент устаревшего снимка' : ''}.`}{uncertain ? ' Есть статусы на уточнении — они видны во всех операциях.' : ''}</p>
  </section>;
}

function Operations({ data, compact = false, onOpen, filter = 'all', onFilter }: { data: DashboardPayload; compact?: boolean; onOpen?: () => void; filter?: OperationFilter; onFilter?: (filter: OperationFilter) => void }) {
  const [venue, setVenue] = useState<'all' | 'mexc' | 'okx'>('all');
  const failed = data.operations.status === 'error';
  const disconnected = data.operations.status === 'not-connected';
  const items = [...data.operations.items].sort((a, b) => b.at - a.at).filter(item =>
    (compact || venue === 'all' || item.venue === venue) && (compact || filter === 'all' || (filter === 'open' ? openOrder(item) : filter === 'pending' ? pendingTransfer(item) : completedOperation(item))));
  const rows = compact ? items.slice(0, 4) : items;
  return <section className="panel account-operations">
    <header className="panel-header"><h2>{compact ? 'Реальные операции и заявки' : 'История реальных счетов'}</h2>{compact && onOpen ? <button className="account-link" onClick={onOpen}>Все операции <ArrowRight size={15} /></button> : null}</header>
    {!failed && !disconnected ? <>
      <p className="operations-coverage">{data.operations.coverageLabel}{data.operations.status === 'partial' ? ' · История неполная' : ''}{!isCurrent(data) ? ' · Статусы на момент снимка' : ''}</p>
      {!compact ? <div className="operations-filters"><div className="operation-tabs" role="group" aria-label="Тип истории">{([['all', 'Все'], ['open', 'Открытые заявки'], ['pending', 'Вводы и выводы в процессе'], ['history', 'История']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => onFilter?.(value)}>{label}</button>)}</div><label><span>Биржа операций</span><select aria-label="Биржа операций" value={venue} onChange={event => setVenue(event.target.value as typeof venue)}><option value="all">Все биржи</option><option value="mexc">MEXC</option><option value="okx">OKX</option></select></label></div> : null}
    </> : null}
    {rows.length && !failed && !disconnected ? <div className="operation-list">{rows.map((item, index) => <details className="operation-row" key={`${item.venue}:${item.type}:${item.id}:${index}`}><summary><span className="operation-description"><strong>{operationLabel(item)}</strong><span>{item.venue.toUpperCase()} · {item.symbol ?? item.asset}</span><span>{time(item.at)}</span></span><span className="operation-result"><strong>{formatAmount(item.amount, 8, false)} {item.asset}</strong><span className={`operation-status ${item.status}`}>{operationStatus[item.status]}</span><span className="account-muted">Подробнее</span></span></summary><dl><div><dt>Количество</dt><dd>{item.amount} {item.asset}</dd></div>{item.quoteAmount !== null ? <div><dt>Сумма сделки</dt><dd>{item.quoteAmount}{item.symbol?.endsWith('USDT') ? ' USDT' : ''}</dd></div> : null}<div><dt>Комиссия</dt><dd>{item.fee === null ? 'Нет данных' : `${item.fee} ${item.feeAsset ?? ''}`}</dd></div><div><dt>Статус на снимке</dt><dd>{operationStatus[item.status]}</dd></div></dl></details>)}</div> : <div className="account-empty"><strong>{failed ? 'История временно недоступна' : disconnected ? 'История бирж ещё не подключена' : filter === 'open' ? 'Открытых заявок в полученных данных нет' : filter === 'pending' ? 'Вводов и выводов в процессе в полученных данных нет' : 'В полученной истории нет операций'}</strong><p>{failed ? 'Балансы и история обновляются независимо.' : disconnected ? 'Здесь появятся реальные сделки, пополнения и выводы MEXC и OKX.' : !isCurrent(data) ? 'Снимок устарел. Текущее состояние операций неизвестно.' : data.operations.status === 'partial' ? 'Получена только часть истории. Отсутствие записей не означает отсутствие операций на биржах.' : 'Показаны только операции, полученные от бирж.'}</p></div>}
    {!compact ? <p className="operations-coverage">Это записи с ваших реальных счетов. Они не означают, что робот совершал эти операции. Виртуальные сделки робота находятся отдельно — в разделе «Симулятор».</p> : null}
  </section>;
}

export function AccountDashboard({ page, state, onNavigate }: { page: AccountPage; state: DashboardLoad; onNavigate: (page: AccountPage) => void }) {
  const [venue, setVenue] = useState<'all' | 'mexc' | 'okx'>('all');
  const [search, setSearch] = useState('');
  const [operationFilter, setOperationFilter] = useState<OperationFilter>('all');
  const openOperations = (filter: OperationFilter) => { setOperationFilter(filter); onNavigate('operations'); };
  const data = state.data;
  if (!data) return <div className="account-dashboard">{page === 'overview' ? <section className="account-overview" key="overview"><StateNotice state={state} />{state.error !== 'session' && state.error !== 'forbidden' ? <BalanceHistory key="history" /> : null}</section> : <StateNotice state={state} />}</div>;
  const current = isCurrent(data);
  const allCurrent = current && data.exchanges.every(exchange => exchangeCurrent(exchange, current));
  const valuationComplete = allCurrent && data.totals.valuationComplete && data.exchanges.every(exchange => exchange.valuationComplete) && data.status !== 'unavailable';
  const coverageComplete = data.exchanges.every(exchange => exchange.coverage?.status === 'complete');
  const total = allCurrent && data.status !== 'unavailable' ? valuationComplete ? data.totals.portfolioUsdt : data.totals.pricedUsdt : null;
  const unpriced = Array.from(new Set(data.exchanges.flatMap(exchange => exchange.unpricedAssets)));
  const notice = !current ? 'Снимок устарел. Актуальные суммы появятся после обновления.' : data.status === 'unavailable' ? 'Не удалось получить счета бирж. Общий баланс пока недоступен.' : data.exchanges.some(exchange => exchange.status !== 'connected') ? 'Часть бирж недоступна. Общий баланс пока не рассчитан.' : null;
  return <div className="account-dashboard">
    <div className="account-context"><span>Реальные счета · только чтение</span><button className="account-link" onClick={() => void state.refresh()} disabled={state.loading} aria-busy={state.loading}><RefreshCw size={15} className={state.loading ? 'spin' : ''} />{state.loading ? 'Обновляем' : 'Обновить'}</button></div>
    <p className="account-refresh-note">Данные бирж обновляются примерно раз в 5 минут. «Обновить» читает последний снимок.</p>
    {notice ? <div className="account-notice" role="status">{notice}</div> : null}
    {page === 'overview' ? <section className="account-overview" key="overview">
      <section className="account-total" aria-labelledby="account-total-title"><span id="account-total-title">{coverageComplete && valuationComplete ? 'Баланс текущих аккаунтов' : 'Учтённый баланс'}</span><div className="account-total-value" title={total ?? undefined}>{formatAmount(total)} <small>USDT</small></div><p>{total === null ? 'Для суммы нужны актуальные данные обеих бирж.' : `${data.exchanges.map(scopeSummary).join('. ')}.${!coverageComplete ? ' Часть кошельков не включена.' : ''}${!valuationComplete ? ` Не все активы оценены${unpriced.length ? ': ' + unpriced.join(', ') : ''}.` : ''}`}</p><div className="account-total-footer"><span>Доступные USDT в Spot / Trading / Funding <strong>{formatAmount(allCurrent ? data.totals.availableUsdt : null)}</strong></span><span>Снимок: {time(data.observedAt)}</span></div></section>
      <OperationSummary data={data} onOpen={openOperations} />
      <EarnPanel data={data} compact onOpen={() => onNavigate('earn')} />
      <BalanceHistory key="history" />
      <section className="panel exchange-list" aria-label="Подключённые биржи">{data.exchanges.map(exchange => <ExchangeRow key={exchange.venue} exchange={exchange} current={current} onOpen={() => { setVenue(exchange.venue); onNavigate('exchanges'); }} />)}</section>
      <Operations data={data} compact onOpen={() => openOperations('all')} />
      <p className="account-footnote">Автоматическая торговля реальными средствами выключена.</p>
    </section> : page === 'earn' ? <EarnPanel data={data} /> : page === 'operations' ? <Operations data={data} filter={operationFilter} onFilter={setOperationFilter} /> : <>
      <p className="account-scope">Показаны текущие аккаунты API-ключей; субаккаунты отдельно не включены. Охват каждого кошелька указан ниже. Доступные USDT относятся к MEXC Spot и OKX Trading/Funding; оценка Earn сама по себе не означает доступность средств для торговли.</p><div className="account-filters"><label><span>Биржа</span><select aria-label="Биржа" value={venue} onChange={event => setVenue(event.target.value as typeof venue)}><option value="all">Все биржи</option><option value="mexc">MEXC</option><option value="okx">OKX</option></select></label><label><span>Найти актив</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Например, USDT" autoComplete="off" /></label></div>
      {data.exchanges.filter(exchange => venue === 'all' || exchange.venue === venue).map(exchange => {
        const fresh = exchangeCurrent(exchange, current);
        const assets = exchange.assets.filter(asset => asset.currency.toLowerCase().includes(search.trim().toLowerCase()));
        return <section className="panel exchange-detail" key={exchange.venue}><ExchangeRow exchange={exchange} current={current} /><WalletCoverage exchange={exchange} current={current} />{fresh ? <>
          <div className="account-asset-scope"><h3>Активы {assetScope(exchange)}</h3><p>Расшифровка остатков только этих кошельков. Оценки остальных кошельков показаны выше.</p></div>
          {!exchange.valuationComplete ? <p className="account-detail-note">Без оценки: {exchange.unpricedAssets.join(', ') || 'часть активов'}. Сумма биржи неполная.</p> : null}
          {assets.length ? <div className="asset-list">{assets.map(asset => <details className="asset-row" key={asset.currency}><summary><span><strong>{asset.currency}</strong><span className="account-muted">{formatAmount(asset.total, 8, false)}</span></span><span className="asset-valuation">{asset.valueUsdt === null ? 'Нет оценки' : `${formatAmount(asset.valueUsdt)} USDT`}<span className="account-muted">Подробнее</span></span></summary><dl><div><dt>Всего</dt><dd>{asset.total} {asset.currency}</dd></div><div><dt>Доступно</dt><dd>{asset.available ?? 'Нет данных'}</dd></div><div><dt>Заблокировано</dt><dd>{asset.locked ?? 'Нет данных'}</dd></div></dl></details>)}</div> : <div className="account-empty">{search ? 'Активы не найдены' : 'В показанных кошельках нет ненулевых остатков'}</div>}
        </> : <div className="account-empty"><WalletCards size={24} /><p>Остатки будут доступны после успешного обновления.</p></div>}</section>;
      })}
    </>}
  </div>;
}
