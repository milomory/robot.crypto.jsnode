import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import type { BalanceHistoryResponse } from '../../src/accounts/balance-history-contract';
import { apiUrl } from './api-url';

type Range = '1d' | '7d' | '30d';
type Series = 'totalUsdt' | 'mexcUsdt' | 'okxUsdt';
type HistoryState = { data: BalanceHistoryResponse | null; loading: boolean; error: 'network' | 'access' | null };
const EMPTY: HistoryState = { data: null, loading: true, error: null };
const DECIMAL = /^-?(?:0|[1-9]\d{0,89})(?:\.\d{1,60})?$/;
const MAX_GAP = 12 * 60_000;
const HEIGHT = 230, LEFT = 78, RIGHT = 20, TOP = 18, BOTTOM = 32;
const SERIES = [{ id: 'totalUsdt', label: 'Всего' }, { id: 'mexcUsdt', label: 'MEXC' }, { id: 'okxUsdt', label: 'OKX' }] as const;
const RANGES = [{ id: '1d', label: '24 ч' }, { id: '7d', label: '7 д' }, { id: '30d', label: '30 д' }] as const;
const date = (at: number) => new Date(at).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const exact = (value: string) => {
  const [integer, fraction] = value.split('.');
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f').replace('-', '−') + (fraction ? ',' + fraction : '');
};
// Round decimal strings only for display; chart geometry keeps every source digit.
function money(value: string): string {
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = value.replace(/^-/, '').split('.');
  let cents = BigInt(integer) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  if ((fraction[2] ?? '0') >= '5') cents += 1n;
  return `${negative && cents !== 0n ? '−' : ''}${exact((cents / 100n).toString())},${(cents % 100n).toString().padStart(2, '0')}`;
}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
function validResponse(value: unknown, range: Range): value is BalanceHistoryResponse {
  if (!isRecord(value) || value.schema !== 1 || value.range !== range || !timestamp(value.from) || !timestamp(value.to) || value.to < value.from || (value.startedAt !== null && !timestamp(value.startedAt)) || (value.updatedAt !== null && !timestamp(value.updatedAt)) || value.transfersCoverage !== 'observed-only' || !Array.isArray(value.points) || value.points.length > 9_000 || !Array.isArray(value.transfers) || value.transfers.length > 2_000) return false;
  let previous = 0;
  for (const point of value.points) {
    if (!isRecord(point) || !timestamp(point.at) || point.at <= previous || point.at < value.from || point.at > value.to || !SERIES.every(({ id }) => point[id] === null || (typeof point[id] === 'string' && DECIMAL.test(point[id] as string)))) return false;
    if (point.basis !== undefined && (!isRecord(point.basis) || !['mexc-spot', 'mexc-spot-futures'].includes(String(point.basis.mexc)) || !['okx-trading-funding', 'okx-account-total'].includes(String(point.basis.okx)))) return false;
    previous = point.at;
  }
  return value.transfers.every(item => isRecord(item) && typeof item.id === 'string' && ['mexc', 'okx'].includes(String(item.venue)) && ['deposit', 'withdrawal'].includes(String(item.type)) && typeof item.asset === 'string' && typeof item.amount === 'string' && DECIMAL.test(item.amount) && timestamp(item.at) && item.at >= (value.from as number) && item.at <= (value.to as number));
}
function useHistory(range: Range, visible: boolean) {
  const [state, setState] = useState<HistoryState>(EMPTY);
  const pending = useRef<AbortController | null>(null);
  const mayRead = useRef(visible);
  mayRead.current = visible;
  const refresh = useCallback(async () => {
    if (!mayRead.current || document.visibilityState !== 'visible' || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setState(current => ({ ...current, loading: true }));
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(apiUrl(`/api/accounts/balance-history?range=${range}`, import.meta.env.VITE_API_BASE), {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal
      });
      if (pending.current !== controller || !mayRead.current) return;
      if (controller.signal.aborted) throw new Error();
      if (response.status === 401 || response.status === 403) {
        setState({ data: null, loading: false, error: 'access' });
        return;
      }
      if (!response.ok) throw new Error();
      const data: unknown = await response.json();
      if (controller.signal.aborted || !validResponse(data, range)) throw new Error();
      if (pending.current === controller && mayRead.current) setState({ data, loading: false, error: null });
    } catch {
      if (pending.current === controller && mayRead.current) setState({ data: null, loading: false, error: 'network' });
    } finally {
      window.clearTimeout(timeout);
      if (pending.current === controller) pending.current = null;
    }
  }, [range]);
  useEffect(() => {
    setState(current => current.data?.range === range ? current : EMPTY);
    if (visible) void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const visibility = () => {
      if (document.visibilityState !== 'visible') {
        const controller = pending.current;
        pending.current = null;
        controller?.abort();
        setState(EMPTY);
      } else void refresh();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
      const controller = pending.current;
      pending.current = null;
      controller?.abort();
    };
  }, [range, visible, refresh]);
  return { ...state, data: state.data?.range === range ? state.data : null, refresh };
}

function units(value: string, scale: number): bigint {
  const [integer, fraction = ''] = value.replace(/^-/, '').split('.');
  return (value.startsWith('-') ? -1n : 1n) * BigInt(integer + fraction.padEnd(scale, '0'));
}
function decimalUnits(value: bigint, scale: number): string {
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, '0');
  return (value < 0n ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}
function axisLabel(value: string): string {
  const negative = value.startsWith('-');
  const [integer, fraction = ''] = value.replace(/^-/, '').split('.');
  if (integer.length <= 6) return money(value);
  // Keep ordinary balances readable. Exact values remain in the SVG title and
  // the touch/keyboard-accessible readout, even beyond a compact axis's range.
  if (integer.length > 15) return negative ? '<−999 трлн' : '>999 трлн';
  const group = integer.length > 12 ? 12 : integer.length > 9 ? 9 : 6;
  const scaled = `${negative ? '-' : ''}${integer.slice(0, -group)}.${integer.slice(-group)}${fraction}`;
  return `${money(scaled)} ${group === 12 ? 'трлн' : group === 9 ? 'млрд' : 'млн'}`;
}
function pointBasis(point: BalanceHistoryResponse['points'][number], series: Series): string {
  const mexc = point.basis?.mexc ?? 'mexc-spot', okx = point.basis?.okx ?? 'okx-trading-funding';
  return series === 'totalUsdt' ? `${mexc}:${okx}` : series === 'mexcUsdt' ? mexc : okx;
}
function basisLabel(point: BalanceHistoryResponse['points'][number], series: Series): string {
  const mexc = point.basis?.mexc === 'mexc-spot-futures' ? 'MEXC Spot и Futures' : 'MEXC Spot';
  const okx = point.basis?.okx === 'okx-account-total' ? 'OKX — текущий аккаунт' : 'OKX Trading и Funding';
  return series === 'totalUsdt' ? `${mexc} · ${okx}` : series === 'mexcUsdt' ? mexc : okx;
}
function geometry(points: BalanceHistoryResponse['points'], series: Series, width: number) {
  const values = points.flatMap(point => point[series] === null ? [] : [point[series]!]);
  if (!values.length) return null;
  const scale = Math.max(...values.map(value => value.split('.')[1]?.length ?? 0));
  const actual = values.map(value => units(value, scale));
  const min = actual.reduce((a, b) => a < b ? a : b), max = actual.reduce((a, b) => a > b ? a : b);
  const span = max - min;
  const start = points[0].at, end = points[points.length - 1].at;
  const x = (at: number) => end === start ? (LEFT + width - RIGHT) / 2 : LEFT + (at - start) / (end - start) * (width - LEFT - RIGHT);
  const y = (value: string) => span === 0n ? (TOP + HEIGHT - BOTTOM) / 2 : HEIGHT - BOTTOM - Number((units(value, scale) - min) * 1_000_000n / span) / 1_000_000 * (HEIGHT - TOP - BOTTOM);
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let segment: Array<{ x: number; y: number }> = [], previousAt = 0, previousBasis = '', basisChanged = false;
  for (const point of points) {
    const basis = pointBasis(point, series);
    const changed = previousBasis !== '' && previousBasis !== basis;
    basisChanged ||= changed;
    if (point[series] === null || (previousAt && point.at - previousAt > MAX_GAP) || changed) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (point[series] !== null) segment.push({ x: x(point.at), y: y(point[series]!) });
    previousAt = point.at; previousBasis = basis;
  }
  if (segment.length) segments.push(segment);
  return { x, y, start, end, segments, basisChanged, count: values.length, min: decimalUnits(min, scale), max: decimalUnits(max, scale) };
}

function HistoryPlot({ data, series }: { data: BalanceHistoryResponse; series: Series }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [width, setWidth] = useState(720);
  const container = useRef<HTMLDivElement>(null);
  const plot = useMemo(() => geometry(data.points, series, width), [data.points, series, width]);
  const hasPlot = plot !== null;
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(280, Math.floor(element.getBoundingClientRect().width)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasPlot]);
  useEffect(() => setSelected(null), [data, series]);
  if (!plot) return <div className="history-empty" role="status">{data.points.length ? 'Для выбранной линии пока нет полной оценки баланса. Пропуски не заменяем нулями.' : 'История ещё не накоплена. График появится после первого снимка.'}</div>;
  const index = selected === null ? data.points.length - 1 : Math.min(selected, data.points.length - 1);
  const point = data.points[index], value = point[series];
  const label = SERIES.find(item => item.id === series)!.label;
  const pointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const position = Math.max(LEFT, Math.min(width - RIGHT, (event.clientX - rect.left) / rect.width * width));
    const target = plot.start + (position - LEFT) / (width - LEFT - RIGHT) * (plot.end - plot.start);
    let nearest = 0;
    data.points.forEach((item, i) => { if (Math.abs(item.at - target) < Math.abs(data.points[nearest].at - target)) nearest = i; });
    setSelected(nearest);
  };
  const keyboard = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setSelected(event.key === 'Home' ? 0 : event.key === 'End' ? data.points.length - 1 : Math.max(0, Math.min(data.points.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))));
  };
  const transfers = data.transfers.filter(item => (series === 'totalUsdt' || item.venue === (series === 'mexcUsdt' ? 'mexc' : 'okx')) && item.at >= plot.start && item.at <= plot.end);
  return <div className="history-plot" ref={container}>
    <div className="history-readout" aria-live="polite" aria-atomic="true"><span>{date(point.at)} · {label}</span>{value === null ? <strong>Нет полной оценки</strong> : <details className="history-exact"><summary aria-label="Показать точное значение баланса"><strong title={exact(value) + ' USDT'}>{money(value)} USDT</strong></summary><span>Точное значение: {exact(value)} USDT</span></details>}<span>{basisLabel(point, series)}</span></div>
    <svg className="balance-chart" viewBox={`0 0 ${width} ${HEIGHT}`} role="group" tabIndex={0}
      aria-label={`История баланса: ${label}. Стрелки влево и вправо выбирают снимок, Home и End — первый и последний.`}
      onPointerMove={pointer} onPointerDown={pointer} onPointerLeave={event => { if (event.pointerType === 'mouse') setSelected(null); }} onKeyDown={keyboard}>
      <title>Баланс учтённых счетов в USDT</title><desc>Линия содержит только полученные снимки. Пропуски, интервалы более двенадцати минут и изменения состава счетов показаны разрывами.</desc>
      {[TOP, (TOP + HEIGHT - BOTTOM) / 2, HEIGHT - BOTTOM].map(y => <line key={y} x1={LEFT} x2={width - RIGHT} y1={y} y2={y} className="history-grid" />)}
      <text x={LEFT - 8} y={(plot.min === plot.max ? (TOP + HEIGHT - BOTTOM) / 2 : TOP) + 5} textAnchor="end" className="history-axis"><title>{exact(plot.max)} USDT</title>{axisLabel(plot.max)}</text>
      {plot.min !== plot.max ? <text x={LEFT - 8} y={HEIGHT - BOTTOM + 4} textAnchor="end" className="history-axis"><title>{exact(plot.min)} USDT</title>{axisLabel(plot.min)}</text> : null}
      {plot.segments.map((segment, i) => segment.length === 1 ? <circle key={i} className="history-point" cx={segment[0].x} cy={segment[0].y} r={4} /> : <path key={i} className="history-line" d={segment.map((p, n) => `${n ? 'L' : 'M'}${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ')} />)}
      {transfers.map(item => <path key={`${item.venue}:${item.type}:${item.id}`} className="history-transfer" d={`M${plot.x(item.at) - 4},${HEIGHT - BOTTOM + 4} l8,0 l-4,6 z`}><title>{item.type === 'deposit' ? 'Пополнение' : 'Вывод'} {exact(item.amount)} {item.asset} · {item.venue.toUpperCase()} · {date(item.at)}</title></path>)}
      {value !== null ? <><line className="history-cursor" x1={plot.x(point.at)} x2={plot.x(point.at)} y1={TOP} y2={HEIGHT - BOTTOM} /><circle className="history-selected" cx={plot.x(point.at)} cy={plot.y(value)} r={5} /></> : null}
      <text x={LEFT} y={HEIGHT - 5} className="history-axis">{date(plot.start)}</text>
      {plot.end !== plot.start ? <text x={width - RIGHT} y={HEIGHT - 5} textAnchor="end" className="history-axis">{date(plot.end)}</text> : null}
    </svg>
    {plot.count === 1 ? <p className="history-hint">История начала собираться: пока доступен один снимок.</p> : plot.basisChanged ? <p className="history-hint">Изменился состав учтённых счетов. Линия разделена; прежние суммы сохранены.</p> : plot.segments.length > 1 ? <p className="history-hint">Пропуски наблюдений показаны разрывами.</p> : null}
    {transfers.length ? <p className="history-hint history-transfer-note"><span aria-hidden="true">▼</span> Отмечены только замеченные пополнения и выводы.</p> : null}
  </div>;
}

// Mounted only on the owner's home screen. Its API is independent of current.json.
export function BalanceHistory() {
  const [range, setRange] = useState<Range>('1d');
  const [series, setSeries] = useState<Series>('totalUsdt');
  const [visible, setVisible] = useState(false);
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '100px' });
    if (section.current) observer.observe(section.current);
    return () => observer.disconnect();
  }, []);
  const state = useHistory(range, visible);
  return <section className="panel balance-history" ref={section} aria-labelledby="balance-history-title">
    <header className="panel-header"><h2 id="balance-history-title">История баланса</h2><button type="button" className="account-link" aria-label="Обновить историю баланса" disabled={state.loading || !visible} onClick={() => void state.refresh()}><RefreshCw size={15} className={state.loading ? 'spin' : ''} /><span>Обновить</span></button></header>
    <div className="history-controls"><div role="group" aria-label="Биржа на графике">{SERIES.map(item => <button key={item.id} type="button" aria-pressed={series === item.id} className={series === item.id ? 'active' : ''} onClick={() => setSeries(item.id)}>{item.label}</button>)}</div><div role="group" aria-label="Период графика">{RANGES.map(item => <button key={item.id} type="button" aria-pressed={range === item.id} className={range === item.id ? 'active' : ''} onClick={() => setRange(item.id)}>{item.label}</button>)}</div></div>
    {state.data ? <HistoryPlot data={state.data} series={series} /> : <div className="history-empty" role={state.error ? 'alert' : 'status'}>{state.error === 'access' ? 'Доступ к истории баланса ограничен. Войдите заново.' : state.error ? 'Не удалось загрузить историю баланса. Повторите обновление.' : 'Загружаем наблюдения баланса…'}</div>}
    <footer className="history-footer">{state.data?.updatedAt ? <span>Последний снимок: {date(state.data.updatedAt)}{Date.now() - state.data.updatedAt > MAX_GAP ? ' · новых данных пока нет' : ''}</span> : null}<span>Баланс учтённых счетов. Пополнения и выводы влияют на сумму. Это не доходность.</span></footer>
  </section>;
}
