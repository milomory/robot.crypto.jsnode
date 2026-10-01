# D0b: стаканы, mark/index, OI и история funding

1 октября 2026. **Полный публичный capture принят: 24/24 GET BTC/ETH и независимый
replay, 6 306 мс.** Приёмка подтверждает схемы и привязку metadata; пригодность
книг для исполнимого сравнения остаётся false из-за времени MEXC REST.

Прежний одиночный Python probe вернул 403; его причина неизвестна. После нового
поручения продолжить выполнена отдельная диагностика тем же штатным Node-клиентом:
на прежнем `www.okx.com` получены HTTP 200 / code 0. Затем принят весь фиксированный
профиль. Адрес/UA/прокси не подменялись. Это подтверждает текущий доступ, но не
объясняет исторический отказ.

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
исполнимого edge; полная WS-книга в этом этапе не реализована. Отдельная
[ограниченная WS-проба](DERIVATIVES-MEXC-DEPTH-SOURCE.md) уже подтвердила matching-engine
`cts` в 10 последовательных BTC-дельтах; к старым REST snapshot это доказательство
не присоединяется задним числом.

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
# Явный одноразовый запуск; не расписание и не автоматический retry:
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
- Новый `fixtures/market-data/d0b-public-20261001.json` и manifest содержат полный
  реальный BTC/ETH capture. SHA-256:
  `4facee5bdf083fb22bfb170fc40275479e125e0afb53f5835ce453f0fb164210`.
  24 ответа, 109 876 байт; 16 зависимых наблюдений привязаны к metadata того же
  capture, максимальный возраст metadata 2 591 мс.
- В OKX истории получены 40 непустых realizedRate; reported OI base совпадает с
  точным contract×size у BTC/ETH. Обе MEXC REST книги имеют `cts:null`. BTC также
  отмечен source-skew 1 267 мс: это разность меток разной семантики, а не
  доказательство рассинхронизации matching engines.
- [Диагностика штатного Node GET](evidence/derivatives-d0b-20261001/okx-node-diagnostic.json)
  сохраняет только безопасные признаки HTTP/API ответа. Исторический 403 evidence
  и D0a fixture сохранены без изменения.
- Compiled CLI replay полного реального capture PASS. D1-таймер не запускался.

## Проверка кода

Исходная offline-версия ([результаты](evidence/derivatives-d0b-20261001/validation.json)): **4 326 PASS**,
15 прежних PostgreSQL skips, API/UI build и строгая типизация PASS. D0b добавил
370 проверок. Независимое ревью обнаружило и помогло закрыть ошибку классификации
общего timeout, из-за которой неполный архив мог не пройти собственный replay.
Проверены также suspend/late timeout и сохранение первоначального HTTP отказа.

## Далее

1. Реконструировать MEXC BTC/ETH книгу из fresh metadata, snapshot и непрерывных
   WS-дельт; первый gap или выход за известный диапазон глубины останавливает приёмку.
2. Закрыть временную семантику остальных метрик, нужных для выбранного расчёта.
3. Завершить связку со Spot и пересчитать бюджет D1: текущий профиль — capability
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

Официальный [OKX changelog от 20 мая 2026](https://www.okx.com/docs-v5/log_en/#2026-05-20)
рекомендует `openapi.okx.com`, но прямо сохраняет поддержку `www.okx.com`.
Смена домена в этой приёмке не требовалась и не выполнялась.

Текущая [приёмка и проверка всего проекта](evidence/derivatives-d0b-20261001/completion-validation.json):
**4 574 PASS**, 15 прежних PostgreSQL skips; API/UI build и строгие типы market-data PASS.
Новые 248 тестов проверяют WS-парсер, transport/replay и оба реальных публичных fixture.

Следующий технический этап выполнен отдельно: [MEXC BTC/ETH top50 восстановление](DERIVATIVES-MEXC-BOOK.md).
Флаги исходного REST-only D0b архива не изменены задним числом.
