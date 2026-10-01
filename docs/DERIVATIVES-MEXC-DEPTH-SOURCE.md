# MEXC: подтверждение времени incremental книги

1 октября 2026. **Отдельная публичная BTC WS-проба принята**, offline replay PASS.
Получено 11 сообщений: acknowledgement и 10 последовательных дельт, все с
matching-engine `cts`. Наблюдение заняло 947 мс; возраст source timestamp при
получении 114–123 мс. Это короткая проверка схемы/источника времени, не измерение
стабильной задержки и не готовая полная книга.

## Проверенный контракт

[Актуальная WS depth документация](https://www.mexc.com/api-docs/futures/websocket-api/order-book-depth)
определяет `push.depth.data.cts` как время matching engine, произведшего данные
книги. [Changelog](https://www.mexc.com/api-docs/futures/update-log) добавил это поле
18 июня 2026. Гарантия относится именно к incremental `push.depth`; на REST
`timestamp` или legacy `push.depth.full` она не переносится.

`ts` хранится отдельно без гарантии времени обновления. `cts:null`/отсутствие,
устаревшее/будущее время не заменяются receipt time. Дельта имеет абсолютное
количество контрактов; ноль удаляет уровень. Версии после первой строго `+1`,
цены/количества/version проходят точный parser без округления через Number.

Публичный [endpoint](https://www.mexc.com/api-docs/futures/websocket-api/native-ws-endpoint):
`wss://contract.mexc.com/edge`. Фиксированная подписка:

```json
{"method":"sub.depth","param":{"symbol":"BTC_USDT","compress":false},"gzip":false}
```

`compress=false` отключает объединение дельт; `gzip=false` задаёт формат транспорта.
Это разные параметры в [официальной legacy reference](https://mexcdevelop.github.io/apidocs/contract_v1_en/#depth).
Их совместная поддержка подтверждена данной короткой реальной пробой, а не
предполагается для любых каналов/будущих версий. [Heartbeat](https://www.mexc.com/api-docs/futures/websocket-api/command-details-for-data-exchange)
использует публичный ping; pong сам по себе не доказывает свежесть книги.

## Ограничения реализации

- `MexcDepthStreamEvidence`: ack/pong/delta, exact amounts, максимум 2 000 уровней
  на сторону; нулевой объём удаляет, неизвестная схема или gap завершает экземпляр.
- `MexcDepthSourceClient`: одно соединение, одна подписка BTC, до 20 секунд от
  начала, без reconnect/retry. Успех только после 10 свежих непрерывных дельт.
- Принятый frame ≤512 KiB, всего ≤4 MiB/32 сообщения; максимум один ping через
  10 секунд после open. Ошибка/закрытие/неподтверждённое время останавливают сбор.
- Native WebSocket выдаёт готовые сообщения: лимиты проверяются после сборки
  frame библиотекой, это **не ограничитель памяти сетевого декодера**. 20 секунд —
  срок принятия данных, не жёсткая гарантия OS scheduler или close handshake.
- Возраст `cts`: не более 5 с в прошлом/будущем относительно локальных часов.
  Clock skew остаётся ограничением этого критерия; `sourceTimeFresh` — только
  характеристика дельты. `bookReconstructed=false`, `bookFreshnessVerified=false`,
  `executable=false` сохраняются всегда.
- Auth, cookies, private channels, REST bootstrap и торговые команды отсутствуют.
  Ошибки сохраняются закрытыми кодами, без текста/заголовков сервера.

## Архив и воспроизводимость

```bash
# Явный одноразовый публичный запуск, не таймер:
npm run lab:mexc-depth-source -- capture /tmp/NEW_DIRECTORY

# Только offline проверка:
npm run lab:mexc-depth-source -- replay /tmp/EXISTING_DIRECTORY
```

Новый каталог 0700, exclusive файлы 0600 и fsync. Partial archive сохраняется до
внутренней проверки, автоматического повтора нет. Replay проверяет canonical JSON,
hash, пределы, хронологию и заново нормализует все raw frames. Лимит архива
32 MiB учитывает raw JSON плюс нормализованные структуры, а не только сетевые
4 MiB. Независимое ревью обнаружило исходный слишком малый лимит 8 MiB;
добавлен regression для допустимого большого capture. Диагностическая
причина непринятого сообщения не доказывается replay: его произвольный текст не
сохраняется. SHA подтверждает байты, не криптографическую аутентичность биржи.
Исторический replay не объявляет архив актуальным рынком.

Реальный fixture: `fixtures/market-data/mexc-depth-source-public-20261001.json`
и manifest, 7 998 байт, SHA-256:
`20453f24d8f8cbcf12ca85110082c9dcf653823f43eddcdf6f89b2d2ce824c7d`.

## Следующий этап

1. Свежие metadata и [REST bootstrap](https://www.mexc.com/api-docs/futures/websocket-api/incremental-order-book-maintenance-mechanism)
   с version; буферизовать WS updates и применить только непрерывные последующие.
2. Проверить целиком reconstruct/replay BTC, затем ETH. Первый gap, drift схемы
   или выход top50 за гарантированно известную границу snapshot останавливает
   приёмку: неизвестная глубина не считается нулевой.
3. Только состояние после принятой непрерывной дельты с `cts` может получить
   проверенное время. Отдельная проба не «освежает» прежние REST-снимки.
4. Принять связь со Spot и новый общий сетевой/дисковый бюджет D1 до расписания.

Ключи, runtime, observer Spot, scan, live-lock, Earn и деньги не изменялись.

Проверки: **4 574 PASS**, 15 прежних PostgreSQL skips, API/UI build и строгие типы PASS;
[сводка evidence](evidence/derivatives-d0b-20261001/completion-validation.json).

Обновление того же дня: [BTC/ETH snapshot + WS восстановление top50](DERIVATIVES-MEXC-BOOK.md)
реализовано и принято отдельными свежими capture; прежняя короткая проба не
использовалась как их metadata или bootstrap.
