import { useEffect, useState } from 'react';
import type { readReport } from '../../src/lab/observations';

type Report = Awaited<ReturnType<typeof readReport>>;
const reasons: Record<string, string> = {
  'source-unavailable': 'Источник недоступен', 'instrument-unavailable': 'Нет правил инструмента',
  'below-minimum-quantity': 'Объём ниже минимума', 'above-maximum-quantity': 'Объём выше максимума',
  'quantity-step-mismatch': 'Объём не соответствует шагу', 'below-minimum-notional': 'Сумма ниже минимума',
  'above-maximum-notional': 'Сумма выше максимума', 'market-not-trading': 'Торги недоступны',
  'stale-instrument': 'Правила инструмента устарели', 'unsynchronised-books': 'Снимки получены в разное время',
  'stale-or-invalid-receipt-time': 'Устаревший снимок', 'stale-or-invalid-source-time': 'Устаревшие данные биржи',
  'insufficient-depth': 'Недостаточно объёма в стакане'
};
export type Payload = { available: false } | { available: true; report: Report };
export function LabReport({ load }: { load: () => Promise<Payload> }) {
  const [report, setReport] = useState<Report | null>(null);
  const [state, setState] = useState('Загрузка отчёта…');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setReport(null); setState('Загрузка отчёта…');
    load().then(payload => {
      if (!active) return;
      if (payload.available) { setReport(payload.report); setState(''); }
      else setState('Наблюдения ещё не подключены. Отчёт появится после сохранения серии.');
    }).catch(() => { if (active) setState('Не удалось загрузить отчёт. Попробуйте обновить.'); });
    return () => { active = false; };
  }, [load, revision]);
  const percent = (bps: number | null) => bps === null ? '—' : `${(bps / 100).toFixed(3)}%`;
  return <section className="panel lab-report">
    <header className="panel-header"><h2>Межбиржевые наблюдения</h2>
      <button className="primary" onClick={() => setRevision(v => v + 1)}>Обновить отчёт</button></header>
    <div className="lab-content">
      <p>Снимки рынка, не сделки и не заработанная прибыль. Издержки заданы для моделирования.</p>
      {state && <p role="status">{state}</p>}
      {report && <>
        <p><strong>{report.symbol}</strong> · объём {report.quantity} · снимков {report.recordedSamples}/{report.expectedSamples}</p>
        <p>Последнее наблюдение: {report.lastObservedAt ? new Date(report.lastObservedAt).toLocaleString() : 'нет'}.
          {' '}Это сохранённые снимки, не текущие котировки.</p>
        {report.collection && <p role="status">{report.collection.state === 'running'
          ? `Сбор идёт, остановится не позже ${new Date(report.collection.deadlineAt).toLocaleString()}. Кнопка обновляет сохранённый отчёт.`
          : report.collection.state === 'completed' ? 'Серия завершена. Сборщик остановлен.'
          : report.collection.state === 'stopped' ? 'Серия остановлена до завершения. Данные сохранены.'
          : report.collection.state === 'interrupted' ? 'Сбор не подтверждает активность. Серия может быть прервана.'
          : 'Сбор завершился с ошибкой. Данные сохранены.'}</p>}
        <p>{report.sizeValidation === 'not-checked'
          ? 'В этой старой серии размеры заявок не проверялись.'
          : 'Проверены опубликованные шаги и лимиты объёма. Сумма заявки оценена по снимку; это не гарантия приёма биржей.'}</p>
        <p>{report.collection?.state === 'running' ? 'Ещё не записано снимков' : 'Пропущено снимков'}: {report.missingSequences.length}. Максимальный интервал: {(report.longestStartGapMs / 1000).toFixed(1)} с.</p>
        <div className="lab-table"><table><thead><tr><th>Биржа</th><th>Получено</th><th>Свежих</th><th>Ошибок</th></tr></thead>
          <tbody>{Object.entries(report.byVenue).map(([venue, value]) => <tr key={venue}>
            <td>{venue}</td><td>{value.received}</td><td>{value.freshAtComparison}</td><td>{value.failed}</td>
          </tr>)}</tbody></table></div>
        <div className="lab-pairs">{Object.entries(report.pairs).map(([pair, value]) => <article className="lab-pair" key={pair}>
          <h3>{pair.replace('->', ' → ')}</h3>
          <p className="lab-net">{percent(value.bestNetBps)}</p><p>Лучшая разница после издержек</p>
          <p>Сравнений: {value.valid} · положительных: {value.positive}</p>
          <p>С проверкой размера: {value.sizeChecked} · отклонено: {value.rejected}</p>
        </article>)}</div>
        <p>Допущения на каждую операцию:</p>
        {Object.entries(report.assumptions).map(([venue, cost]) => <p key={venue}>
          {venue}: комиссия {percent(cost.feeBps)}, проскальзывание {percent(cost.slippageBps)}.
        </p>)}
        <details><summary>Причины отклонений и ограничения</summary>
          {Object.entries(report.pairs).map(([pair, value]) => Object.keys(value.reasons).length > 0 &&
            <p key={pair}>{pair.replace('->', ' → ')}: {Object.entries(value.reasons).map(([reason, count]) => `${reasons[reason] ?? 'Данные не прошли проверку'}: ${count}`).join(', ')}</p>)}
          {report.instruments && Object.entries(report.instruments).map(([venue, item]) => <p key={venue}>
            {venue}: {item.available
              ? `минимум ${item.instrument.lots.map(lot => lot.min).join(' / ')}, шаг ${item.instrument.lots.map(lot => lot.step).join(' / ')}; минимум суммы ${item.instrument.minQuote ?? 'не опубликован'}`
              : 'правила недоступны'}
          </p>)}
          <p>Binance: время получения вместо времени биржи. Переводы, перебалансировка и фактические тарифы аккаунтов не учтены. Не все ограничения бирж доступны в публичных данных.</p>
        </details>
      </>}
        </div>
  </section>;
}
