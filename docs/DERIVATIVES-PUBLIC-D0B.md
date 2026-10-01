# D0b: стаканы, mark/index, OI и история funding

1 октября 2026. **Код реализован и проверен offline; полная сетевая приёмка не
выполнена.** Три публичных MEXC BTC GET прошли. Первый OKX books GET ответил 403,
последующие пробы прекращены. Причина отказа не установлена. Полный новый capture
не запускался; старое успешное D0a не подменяет его приёмку.

## Реализованный объём

`src/market-data/observation-model.ts` фиксирует маршруты BTC/ETH linear USDT
perpetual. Новые `mexc-observations.ts` и `okx-observations.ts` нормализуют:

| Данные | MEXC | OKX |
| --- | --- | --- |
| Стакан | depth, максимум 50 уровней на сторону | books `sz=50` |
| Mark / index | fairPrice / indexPrice из ticker | отдельные mark-price / index-tickers |
| Открытый интерес | holdVol в контрактах | oi в контрактах, oiCcy в базовом активе, oiUsd в USD |
| История funding | первая страница, не более 20 settlement | первая страница, limit 20; realizedRate отдельно от прогноза |

Количество в стакане и OI пересчитывается как contracts × basePerContract, без
промежуточного JavaScript Number. Цена/количество уровней проверяются по tick/lot
спецификации того же инструмента; crossed, duplicate и несортированные уровни
отклоняются. Метаданные выбираются из ранее принятых raw-ответов **того же capture**.
Их возраст по receipt ограничен 20 минутами; source update time этим не доказан.

OKX oiCcy сохраняется отдельно от рассчитанного количества базового актива:
`matches/differs` показывает расхождение. Документация не обещает тождественного
округления. oiUsd остаётся USD и не объявляется USDT.

История строго убывает по settlement time, дубли/конфликты отвергаются. Нет
автоматической пагинации, заполнения пропусков прогнозом или универсальных 8 часов.
MEXC сохраняет сообщённый цикл каждого события; OKX интервал остаётся неизвестным.
`historyComplete=false`, `continuityVerified=false`, `realizedAccountIncome=null`.
Это ставки рынка, не начисления нашему счёту.

## Семантика времени — отдельная проверка

| Источник | Документированный смысл | Подтверждает обновление наблюдаемого значения? |
| --- | --- | --- |
| MEXC REST depth timestamp | системное время | Нет; гарантия WS matching-engine cts на REST не переносится |
| MEXC ticker timestamp | время сделки | Нет для mark/index/OI |
| OKX REST books ts | формирование книги | Да, с проверкой возраста |
| OKX index ts | обновление цены | Да, с проверкой возраста |
| OKX REST mark/OI ts | возврат данных | Нет |

`ageStatus` отдельно показывает возраст/будущее/отсутствие timestamp, а
`representsUpdate` — его смысл. Недавняя сделка или свежий HTTP-ответ не делает
все вложенные значения свежими. Корректный старый snapshot можно сохранить для
исследования; он не получает признак пригодности.

`observation-quality.ts` оценивает пару книг на момент получения второй: возраст
не более 5 с, receipt/source skew не более 1 с, пригодные metadata и подтверждённый
смысл timestamp. **С текущими REST-доказательствами MEXC общая пара не получает
`usableForBookComparison=true`.** Это не замалчивается и не заменяется временем
Athena. Нужен подтверждённый источник времени книги перед допуском к исследованию
исполнимого edge; полноценный WS-контракт в этом этапе не реализован.

## Одноразовый профиль и архив

Новый `DerivativesObservationClient` изолирован от принятого D0a и server startup.
План фиксирован: **24 GET максимум** — на каждый BTC/ETH две metadata, два текущих
funding, MEXC ticker, три OKX metrics, две страницы history и две книги подряд.

- По одному запросу; только фиксированные origin/path/query, без credentials,
  cookies, Authorization, redirects, retries и fallback.
- Book timeout 3 с, остальные 5 с, включая body; ответ максимум 512 KiB.
  Общий бюджет 125 с. Первая transport/schema ошибка останавливает весь профиль.
- Пауза процесса может задержать обработку timeout. Неполный архив сохраняет
  первичную ошибку и фактическое elapsed time; успешные наблюдения и полный
  результат обязаны укладываться в бюджет. Это не жёсткая гарантия OS scheduler.
- Новый каталог 0700; capture/manifest 0600, exclusive writes и fsync.
  При ошибке файлы сохраняются, автоматического нового запуска нет.

```bash
# Только после разрешения блокера API и принятия нового сетевого запуска:
npm run lab:derivatives-observe -- capture /tmp/NEW_UNIQUE_DIRECTORY

# Offline, без обращений к API:
npm run lab:derivatives-observe -- replay /tmp/EXISTING_DIRECTORY
```

`observations-replay.ts` проверяет SHA, канонический JSON, фиксированный порядок
маршрутов, лимиты и receipt chronology. Затем повторно парсит raw, заново выбирает
metadata и сверяет все normalized/quality fields. Изменить только готовое
количество/quality или raw без согласованных результатов недостаточно для приёмки.

SHA-256 подтверждает соответствие байтов manifest, **не аутентичность биржи**.
Согласованно сфабрикованный архив и новый hash не становятся сетевым доказательством.
Replay использует исторические receipt times и не объявляет старый снимок свежим.
Capture и manifest записываются до replay: внутренний отказ проверки не уничтожает
диагностический материал. Успешный replay неполного архива доказывает его
согласованность, а не успешность всех запросов.

## Доказательства и границы

- [OKX probe](evidence/derivatives-d0b-20261001/okx-public-probe.json): ровно один
  BTC books GET, HTTP 403; четыре последующих не выполнены. Запросы не повторялись,
  API-origin не менялся. `recordedAt` — время фиксации результата: точный requestedAt
  не был сохранён и не восстановлен предположением. Headers/body отказа не сохранялись.
- `fixtures/market-data/mexc-d0b-public-20261001.json`: три фактических публичных
  BTC ответа (books/ticker/history) и исходные receipts. Это исследование схем,
  **не полный capture**: metadata в том запуске не запрашивались, ETH не проверялся.
- Старая D0a metadata старше допустимого binding-окна. Тесты реальных MEXC raw
  используют явно synthetic metadata для проверки схемы; отдельный тест отвергает
  попытку присоединить старые реальные metadata как свежие.
- OKX новые ответы проверены на документированных synthetic fixtures. Они не
  называются реальной сетевой приёмкой. D0a raw fixture сохранён без изменения.
- Compiled CLI replay проверен на отдельно помеченном synthetic failure archive,
  без сетевых запросов. Полный новый capture и D1-таймер не запускались.

## Проверка кода

[Результаты](evidence/derivatives-d0b-20261001/validation.json): **4 326 PASS**,
15 прежних PostgreSQL skips, API/UI build и строгая типизация PASS. D0b добавил
370 проверок. Независимое ревью обнаружило и помогло закрыть ошибку классификации
общего timeout, из-за которой неполный архив мог не пройти собственный replay.
Проверены также suspend/late timeout и сохранение первоначального HTTP отказа.

## Далее

1. Установить причину OKX 403 и подтвердить штатный разрешённый API-доступ;
   новый запуск не выполняется автоматически и не использует другой origin для обхода.
2. Закрыть временную семантику MEXC и остальных метрик, нужных для выбранного расчёта.
3. Принять полный BTC/ETH capture со свежими metadata и его независимый replay.
4. Завершить связку со Spot и пересчитать бюджет D1: текущий профиль — capability
   check, его нельзя молча повторять каждую минуту как готовый наблюдатель.

Net edge, исполнимый капитал, account eligibility и derivatives fees не вычислены;
все результаты остаются `executable=false`. Новые ключи для этой работы не нужны.

## Первичные источники

MEXC: [depth](https://www.mexc.com/api-docs/futures/market-endpoints/get-contract-order-book-depth),
[ticker](https://www.mexc.com/api-docs/futures/market-endpoints/get-ticker-contract-market-data),
[funding history](https://www.mexc.com/api-docs/futures/market-endpoints/get-funding-rate-history).

OKX: [books](https://app.okx.com/docs-v5/en/#order-book-trading-market-data-get-order-book),
[mark](https://app.okx.com/docs-v5/en/#public-data-rest-api-get-mark-price),
[index](https://app.okx.com/docs-v5/en/#public-data-rest-api-get-index-tickers),
[OI](https://app.okx.com/docs-v5/en/#public-data-rest-api-get-open-interest),
[funding history](https://app.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate-history).
Официальный docs mirror использован только для чтения документации, не как новый
API-origin. План и ограничения: [D0–D5](DERIVATIVES-OPPORTUNITY-PLAN.md).
