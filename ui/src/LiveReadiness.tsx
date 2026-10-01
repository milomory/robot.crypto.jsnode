import { Bot, LockKeyhole, Play } from 'lucide-react';
import './LiveReadiness.css';

type RuntimeStatus = {
  mode: 'paper' | 'live';
  liveTradingLocked: boolean;
  serverTime: string;
  access?: { role: 'viewer' | 'operator' };
};

// This is a dated implementation plan, not an automated readiness verdict.
// Source: docs/PAIR-NEXT-STEPS.md, reviewed 2026-09-28.
const preparation = [
  {
    title: 'Отправка реальных заявок',
    detail: 'Подключить исполнение заявок MEXC и OKX и отдельный учёт реальных сделок. Сейчас реализован симулятор.'
  },
  {
    title: 'Сбой связи и перезапуск',
    detail: 'Проверить восстановление реальных заявок и исходов без повторной покупки или продажи.'
  },
  {
    title: 'Комиссии и учёт сделок',
    detail: 'Уточнить правила бирж и сверить ненулевые исполнения с фактическими списаниями и комиссиями.'
  },
  {
    title: 'Результат после расходов',
    detail: 'Подтвердить преимущество стратегии с учётом расходов. В завершённом суточном сравнении BTC/USDT положительных возможностей не обнаружено.'
  },
  {
    title: 'Капитал и лимиты',
    detail: 'Выбрать торговую сумму, допустимый убыток и предел оставшейся позиции для реального режима.'
  }
] as const;

export function LiveReadiness({ status }: { status?: RuntimeStatus }) {
  const locked = status?.liveTradingLocked === true;
  const snapshotTime = status?.serverTime ? new Date(status.serverTime) : null;
  const observedAt = snapshotTime && Number.isFinite(snapshotTime.getTime())
    ? snapshotTime.toLocaleString('ru-RU') : null;

  return <div className="live-readiness">
    <section className="live-launch" aria-labelledby="live-launch-title">
      <div className="live-launch-heading">
        <Bot size={25} aria-hidden="true" />
        <div><span>Торговля реальными средствами</span><h2 id="live-launch-title">Запуск пока недоступен</h2></div>
      </div>
      <p>Здесь будет отдельный запуск робота на MEXC и OKX после завершения подготовки. Подключённые счета и история бирж доступны отдельно.</p>
      <div className="live-launch-state">
        <LockKeyhole size={16} aria-hidden="true" />
        <span>{locked ? 'Реальные сделки заблокированы' : 'Состояние блокировки требует проверки'}</span>
      </div>
      {observedAt ? <p className="live-runtime-time">Состояние сервиса на {observedAt}</p> : null}
      <button type="button" className="primary live-start" disabled aria-describedby="live-start-reason">
        <Play size={16} aria-hidden="true" />Запустить реального робота
      </button>
      <p id="live-start-reason" className="live-start-reason">Сначала нужно завершить план подготовки ниже. Этот экран не включает торговлю.</p>
      {status?.access?.role === 'viewer' ? <p className="live-access-note">Текущий вход даёт доступ к просмотру. Управление реальной торговлей требует отдельного операторского доступа.</p> : null}
    </section>

    <section className="panel live-plan" aria-labelledby="live-plan-title">
      <header className="panel-header"><h2 id="live-plan-title">План подготовки</h2><span>Версия от 28 сентября 2026</span></header>
      <p className="live-plan-caption">Зафиксированные задачи. Это не автоматическая проверка готовности.</p>
      <ol>{preparation.map(item => <li key={item.title}><strong>{item.title}</strong><p>{item.detail}</p></li>)}</ol>
    </section>
  </div>;
}
