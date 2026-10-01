# Совместное наблюдение Spot / perpetual MEXC и OKX

1 октября 2026. Отдельный одноразовый public capture BTC или ETH, общий момент
проверки времени и воспроизводимый архив. Основной робот и recurring observer
не импортируются. Полученные книги не означают доступный капитал или прибыль.

## Контракт и сетевой бюджет

На один явно выбранный base максимум **9 GET, 1 WS, 1 subscription**:

1. OKX perpetual metadata, OKX Spot metadata, MEXC Spot metadata и MEXC Spot
   depth 50 последовательно. Последний сохраняется для диагностики.
2. MEXC perpetual: fresh metadata, публичный WS с буферизацией, один REST
   bootstrap 1000 и непрерывные delta versions, проверенные top 50. При начальном
   разрыве разрешён один дополнительный GET последних 1000 depth commits.
3. После закрытия MEXC WS — два параллельных GET: OKX perpetual и OKX Spot depth 50.
4. После последнего результата все книги оцениваются на одном `evaluatedAt`.

Маршруты заданы в коде; произвольный URL, authentication и account API отсутствуют.
Metadata ≤5 с, book GET ≤3 с, вложенный MEXC capture ≤25 с / WS ≤20 с,
общий capture ≤50 с. Concurrency ≤2. На REST response/frame ≤512 KiB;
сумма raw ≤7 MiB (MEXC ≤4 MiB, остальные шесть ответов ≤3 MiB).
Нормализованный архив отдельно ограничен 132 MiB.

Для совместного capture применяется явный MEXC профиль `joint-recovery-v1`: до 4096
frames и до трёх GET внутри MEXC; прежние пределы времени и raw bytes сохранены.
Старый `lab:mexc-book`
по умолчанию сохраняет профиль 256 и прежние архивы/проверки. Увеличение лимита
не разрешает пропускать версии, превышать 4 MiB или делать повторный bootstrap.

Первый HTTP/API/schema/clock/budget failure завершает capture; в последней паре
GET ошибка отменяет peer. Неизвестный текст ошибки не сохраняется. Нет retries,
reconnect, fallback origin, таймера кампании или фонового продолжения.
MEXC Spot weight: metadata 25 + book 3, отдельно от Futures и лимитов OKX;
число GET не следует выдавать за суммарный API weight.

```bash
npm run lab:joint-books -- capture BTC /tmp/NEW_BTC_DIRECTORY
npm run lab:joint-books -- capture ETH /tmp/NEW_ETH_DIRECTORY
npm run lab:joint-books -- replay /tmp/EXISTING_DIRECTORY
```

Каталог 0700, файлы 0600, exclusive create + fsync. Даже неполный capture сначала
сохраняется, затем проверяется. Успех replay означает целостность принятого
префикса, не успешный сетевой сбор. SHA не доказывает подлинность биржи.

## Что сравнимо

Качество проверяется отдельно для четырёх рынков и шести направлений: два
perp/perp и четыре long Spot / short perpetual. Ошибка известного рынка
исключает только связанные направления; неизвестная identity исключает набор.

- Identity, metadata из того же capture, tick/lot и contract→base quantities
  проверяются заново. Metadata возраст ≤20 мин при общем времени.
- MEXC perpetual source: matching-engine `cts` после непрерывного merge.
  OKX source: документированное время генерации книги `ts`.
- Source age ≤5 с; future tolerance ≤1 с относительно receipt и evaluatedAt.
  Между двумя ногами source skew и receipt skew ≤1 с.
- Старые `sourceFreshnessVerified`/`ageMs` не доказывают новую свежесть.
  Прежняя MEXC книга может устареть, пока ожидаются остальные ответы.
- MEXC Spot REST не даёт доказанного update timestamp и явных tick/step;
  precision и minimum quantity не превращаются в шаг. Его пары исключаются
  даже при наличии случайного `ts` в ответе.

`status=complete` означает завершённый сбор, а не синхронность. Пригодность
каждого направления хранится в `quality.pairs`. Весь результат остаётся
`executable=false`, `netEdgeBps=null`. Ни funding, ни mark/OI в новый профиль
не добавлены: их пригодное время и денежные события — следующий контракт.

Каждый GET повторно проверяет общий deadline непосредственно перед отправкой.
Если второй запрос пары уже нельзя отправить, `notDispatched=true` сохраняет
запланированное чтение, но не увеличивает число фактических запросов.

Replay проверяет exact raw metadata/books, вложенный MEXC merge, порядок фаз,
общий deadline, причинность peer cancellation, бюджеты и всю derived quality.
Непринятые payload не сохраняются; закрытый failure code не выдаётся за доказанную
по архиву причину сетевого отказа.

## Расчёт расходов без выдуманной прибыли

`src/market-data/joint-cost-scenario.ts` экспортирует чистую функцию
`calculateJointCostScenario()`. Это отдельный **offline сценарий**, не оценка
доходности сохранённых текущих котировок. Нужны одна quantityBase и четыре
независимые книги: longEntry BUY, shortEntry SELL, longExit SELL, shortExit BUY;
для каждого исполнения отдельно указан feeBps.

Дополнительно явно заданы signed fundingQuote, borrowQuote, rebalanceQuote,
safetyQuote. `null` означает неизвестно; он не заменяется нулём. Если нет цены
выхода, тарифа, расхода или достаточной глубины, итоговый net остаётся неизвестным.

Формула price PnL: longExit + shortEntry − longEntry − shortExit. Затем вычитаются
четыре комиссии и расходы, добавляется signed funding. Если начальный разрыв
цен сохранился на выходе, сам этот разрыв не стал прибылью.

BigInt 30 dp, buy quote округляется вверх, sell вниз, fees вверх. Fees считаются
с точного произведения до округления quote. Depth-walk уже включает slippage;
оно отдельно показывается, но повторно не вычитается. Net bps округляется вниз,
знаменатель — long-entry notional одной ноги, **не капитал и не ROI**.

Функция не подтверждает instrument identity, freshness, account fees, margin,
ликвидационную безопасность или вероятность исполнения. Даже полный сценарий
имеет `scenarioOnly=true`, `executable=false` и отдельные verification=false.

## Первое фактическое наблюдение

Первоначальная BTC-проверка профилем 256 остановилась за 1732 мс после 6 GET / 1 WS:
ACK + 255 delta заполнили frame budget до получения bootstrap. Принятый префикс
воспроизводится; завершённая книга и последующие OKX книги отсутствуют.
Это не успешная синхронизация. Архив 214770 байт, raw 46247 байт сохранён:
[initial evidence](evidence/joint-books-20261001/initial-attempt.json).

Из этого наблюдения следует необходимость отдельного burst profile; исходный
неполный архив не заменяется новым и не считается положительным результатом.

## Длительное наблюдение

Текущий one-shot не включается по cron. Два прежних MEXC bootstrap архива занимают
500198 байт; 1440 повторов дают 720285120 байт (≈687 MiB) ещё без OKX/Spot — больше
плановых 512 MiB. Также получилось бы 2880 WS connections/сутки.

Перед D1 нужен протокол удержания WS и ограниченных chunks/checkpoints с replay,
измеренным byte budget и отдельным расписанием metadata/funding/history.
Паузы, gaps и недоступность сохраняются как результаты, а не скрытые повторы.
Поиск положительного net и реальное исполнение этим этапом не включаются.

## Источники контрактов

- [MEXC Spot exchange information](https://www.mexc.com/api-docs/spot-v3/market-data-endpoints/exchange-information): precision/minimum, weight 25.
- [MEXC Spot order book](https://www.mexc.com/api-docs/spot-v3/market-data-endpoints/order-book): lastUpdateId без source timestamp, weight 3.
- [OKX instruments](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments): Spot tickSz/lotSz/minSz.
- [OKX books](https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-order-book): ts генерации, Spot объёмы в base.
- [MEXC bootstrap/WS контракт](DERIVATIVES-MEXC-BOOK.md), [общий план](DERIVATIVES-OPPORTUNITY-PLAN.md).


## Диагностика стыковки bootstrap

После устранения burst-limit второй capture остановился на версии. Отдельный
контролируемый диагностический capture сохранил публичный REST ответ до merge:
V=42267265960, тогда как первый полученный WS delta был V=42267265967. Версий
для обязательного V+1 перехода нет, поэтому книга правильно отвергнута. Причина
предыдущего отказа без сохранённого rejected snapshot остаётся менее определённой.
[Все неполные результаты](evidence/joint-books-20261001/bootstrap-diagnosis.json) сохранены.

Для joint-профиля добавлена ограниченная буферизация: единственный bootstrap
запрашивается только после ACK и не раньше чем через 250 мс после первого delta.
Так у REST есть время догнать начало буфера; это не гарантия. Следующая проверка
всё ещё получила gap и сохранена как отдельный [неполный результат](evidence/joint-books-20261001/warm-attempt.json). Warmup
входит в исходные 20/25/50 секунд и отменяется при остановке. Replay проверяет
эту границу для принятого bootstrap; старые неполные префиксы без него сохранены.


## Ограниченное восстановление начального разрыва

Профиль `joint-recovery-v1` использует официальный
[depth commits](https://www.mexc.com/api-docs/futures/market-endpoints/get-the-last-n-depth-snapshots)
ровно один раз и только если начальный snapshot старше первого buffered WS delta.
Запрос `/api/v1/contract/depth_commits/{symbol}/1000`, ≤3 с, ≤1000 commits;
весь MEXC capture по-прежнему ≤25 с и ≤4 MiB raw. Итого обычно 8 GET, при bridge 9 GET.
Это не повтор bootstrap и не бесконечное восстановление потока. Любой последующий
gap, неполная цепочка, HTTP/schema/rate failure останавливает capture.

Применяются все версии snapshotV+1..firstWsV−1 без пропуска. Коммиты не имеют
доказанного source timestamp и не получают фиктивный cts. Они только достраивают
начальную книгу; свежесть подтверждается последующим непрерывным WS с cts.
Первоначальная известная глубина не расширяется; после bridge может сузиться.
Конфликт одинаковой версии между сохранёнными commits и WS отвергается,
включая WS-версии, пришедшие после окончания bootstrap. Будущие commits
сохраняются только для проверки совпадения и не продвигают книгу или её время.

Сохраняются исходный snapshot, raw commits и derived bridged snapshot. Если
recovery GET не завершился, `recoveryPending` сохраняет валидный bootstrap,
обосновывающий единственный дополнительный запрос. Replay проверяет его отдельно.
Старые профили 256 и `joint-4096` не получают recovery автоматически.


## Burst и вычислительный бюджет

Первый запуск recovery-профиля получил полный snapshot без необходимости bridge,
но накопил 1912 WS-дельт за 514 мс; 1904 новых версии применены к snapshot.
Обработка заняла 19995 мс, и итог правильно остался `book-stream-timeout`.
Raw и manifest сохранены как [отдельный неполный результат](evidence/joint-books-20261001/merge-timeout-attempt.json).
Скорость обработки тоже входит в возраст книги и общий бюджет; непрерывность
версий сама по себе не делает результат свежим.


## Приёмка итоговой версии

Два новых compiled capture и независимое восстановление raw приняты:

| Base | GET / WS | Capture | Frames / применено | Возраст MEXC книги | Пригодные направления |
| --- | --- | --- | --- | --- | --- |
| BTC | 8 / 1 | 2960 мс | 108 / 99 | 674 мс | 4 из 6 |
| ETH | 8 / 1 | 3207 мс | 11 / 10 | 440 мс | 4 из 6 |

На каждом base пригодны оба perp/perp направления и два OKX Spot → perpetual.
Два направления с MEXC Spot исключены. В этих двух наблюдениях snapshot уже
состыковался с WS; дополнительный commits GET не понадобился. Recovery проверен
synthetic/replay тестами, но успешного реального вызова этого маршрута в этом
этапе нет. Не выдаём его за сетевую приёмку recovery.

[Полное доказательство](evidence/joint-books-20261001/acceptance.json) включает
SHA, raw/normalized bytes, source/receipt skew, metadata age, независимые top50
и проверку отсутствия приватных полей. Public fixtures сохраняют raw и manifest.
За весь этап: пять отдельных неуспешных и два успешных capture, 46 GET / 7 WS.
Каждая новая попытка следовала конкретному изменению или отдельной диагностике;
автоматических повторов нет. Все исходные неуспешные результаты сохранены.

Обработка 1904 дельт ускорена до 1441 мс в отдельном offline прогоне. Точное
BigInt-представление цены кэшируется по identity внутренних неизменяемых строк;
удалённые строки не удерживаются WeakMap. Полные сортировки и все проверки
сохранены. Независимые raw Maps и прежняя реализация на 80 synthetic обновлениях
подтвердили совпадение результатов. Это измерение конкретного архива, не SLA.

Следующий этап — пригодные timestamps и события funding, затем протокол
длительного наблюдения с измеренным объёмом chunks/checkpoints. Простой повтор
one-shot не принят: только два успешных архива этого этапа занимают 594409 байт;
1440 пар дали бы 855948960 байт (≈816 MiB), ещё без funding и burst overhead.
Длительный сбор, account derivatives readiness и реальное исполнение не включены.

Проверки итоговой версии: **5 470 PASS**, 15 прежних PostgreSQL skips;
API/UI build и строгие типы market-data PASS.
[Validation](evidence/joint-books-20261001/validation.json).
