import { ArrowRight } from 'lucide-react';
import type { AccountDashboard } from '../../src/accounts/dashboard-contract';
import { okxEarnSchema, type EarnPeriod } from '../../src/accounts/earn-contract';
import { mexcEarnSchema } from '../../src/accounts/mexc-earn-contract';
import './EarnPanel.css';

export function validEarn(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join(',') === 'mexc,okx' &&
    okxEarnSchema.safeParse(record.okx).success && mexcEarnSchema.safeParse(record.mexc).success;
}
function money(value: string | null | undefined, digits = 2): string {
  if (value == null) return '—';
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const factor = 10n ** BigInt(digits);
  let units = BigInt(whole) * factor + BigInt((fraction + '0'.repeat(digits)).slice(0, digits));
  if ((fraction[digits] ?? '0') >= '5') units++;
  const prefix = negative && units !== 0n ? '−' : '';
  return prefix + (units / factor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f') + ',' + (units % factor).toString().padStart(digits, '0');
}
function date(value: number | null): string {
  return value === null ? '—' : new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function Period({ period, fresh }: { period: EarnPeriod; fresh: boolean }) {
  const unavailable = !fresh || period.coverage === 'unavailable' || period.records === 0;
  return <div className="earn-period"><span>Начисления за {period.days} дней</span>
    <strong title={!unavailable ? period.recordedEarningsUsdt ?? undefined : undefined}>{money(unavailable ? null : period.recordedEarningsUsdt, 6)} <small>USDT</small></strong>
    <span className="account-muted">{!fresh ? 'Снимок устарел' : period.coverage === 'complete' ? 'По истории начислений' : period.coverage === 'partial' ? `Полнота не подтверждена · ${period.records} записей` : 'Нет подтверждённых данных'}</span>
  </div>;
}
export function EarnPanel({ data, compact = false, onOpen }: { data: AccountDashboard; compact?: boolean; onOpen?: () => void }) {
  const value = data.earn?.okx;
  const current = Date.now() >= data.observedAt && Date.now() - data.observedAt <= 600_000 && data.status !== 'stale';
  const fresh = current && !!value && Date.now() >= value.observedAt && Date.now() - value.observedAt <= 600_000;
  const okx = data.exchanges.find(row => row.venue === 'okx');
  const wallet = okx?.coverage?.wallets.find(row => row.id === 'earn');
  const total = current && okx?.status === 'connected' && wallet?.status === 'included' ? wallet.valueUsdt : null;
  return <section className="panel earn-panel" aria-label="Earn на реальных счетах">
    <div className="panel-header"><h2>Earn · реальные средства</h2>{compact ? <button type="button" className="account-link" onClick={onOpen}>Подробнее <ArrowRight size={16} /></button> : null}</div>
    <div className="earn-body"><section className="earn-venue" aria-label="OKX Earn">
      <div className="earn-venue-heading"><h3>OKX</h3><span className="account-muted">{value ? 'Simple Earn Flexible · USDT' : 'Подключаем историю начислений'}</span></div>
      {compact ? <div className="earn-compact"><div><span>Всего в Earn</span><strong>{money(total)} <small>USDT</small></strong></div><div><span>Начислено за 7 дней</span><strong>{money(fresh && value && value.periods.days7.records > 0 ? value.periods.days7.recordedEarningsUsdt : null, 6)} <small>USDT</small></strong><span className="account-muted">{!value ? 'История ещё не получена' : !fresh ? 'Актуальные данные недоступны' : value.periods.days7.coverage === 'partial' ? 'Полнота истории не подтверждена' : value.periods.days7.coverage === 'unavailable' ? 'Нет данных' : 'По истории начислений'}</span></div></div> : <>
        <div className="earn-metrics"><div className="earn-period"><span>Размещено в Flexible, USDT</span><strong title={fresh ? value?.principalUsdt ?? undefined : undefined}>{money(fresh ? value?.principalUsdt : null)}</strong><span className="account-muted">{value?.balanceStatus === 'available' && fresh ? 'По данным продукта' : 'Данные недоступны'}</span></div>
          {value ? <><Period period={value.periods.days7} fresh={fresh} /><Period period={value.periods.days30} fresh={fresh} /></> : <div className="account-muted">История начислений ещё не получена.</div>}
        </div>
        <p className="earn-note">Фактическая годовая доходность: —. Для расчёта нужна история размещённой суммы во времени; текущего остатка недостаточно.</p>
        <details className="earn-details"><summary>Охват и качество данных</summary><p>Учтён только USDT в Simple Earn Flexible. Другие продукты и валюты сюда не входят. В общей оценке Earn по OKX сейчас {money(total)} USDT; она уже включена в баланс биржи и повторно не прибавляется.</p>
          {value ? <><p>Снимок: {date(value.observedAt)}. История: {value.history.pages} страниц, {value.history.records} записей. {value.history.gapsDetected ? 'Почасовая полнота не подтверждена: время начислений отклоняется от ровного часового шага.' : ''} {value.history.duplicateRecords ? 'Обнаружены повторяющиеся записи; период не считается полным.' : ''}</p>
            <p>{value.history.pagination === 'window-covered' ? 'Получены страницы до начала выбранного периода.' : value.history.pagination === 'exhausted' ? 'Все доступные страницы получены.' : 'Чтение истории завершено с ограничением.'}</p>
            <p>Полученные начисления: {date(value.history.firstRecordAt)} — {date(value.history.lastRecordAt)}. Неполная история не означает отсутствие дохода в остальные дни.</p>
            <p>Начисления показаны ровно как их сообщает биржа. Изменение общего баланса и рекламная ставка не используются как фактическая прибыль.</p></> : <p>Сборщик ещё не передал историю. Прочерк означает отсутствие данных, а не нулевой доход.</p>}
        </details>
      </>}
    </section>
    <section className="earn-venue earn-mexc" aria-label="MEXC Earn"><div className="earn-venue-heading"><h3>MEXC</h3><span className="earn-pending">Начисления ещё не подключены</span></div><p className="earn-note">Размещения и доход пока неизвестны. Остаток Spot не позволяет определить, сколько участвует в Earn.</p>{!compact ? <details className="earn-details"><summary>Что осталось для подключения MEXC</summary><p>Найден официальный интерфейс Earn. Нужно подтвердить способ доступа и формат начислений. Существующие ключи сохранены; дополнительных действий с деньгами не требуется.</p><p>Hold and Earn использует активы Spot, Futures Earn — фьючерсного кошелька. Эти средства нельзя повторно прибавлять к общему балансу.</p></details> : null}</section>
    {!compact ? <p className="earn-note">Этот раздел только читает данные. Размещения, погашения и переводы здесь не выполняются.</p> : null}
    </div>
  </section>;
}
