# Crypto Robot: локальная интеграция Auth Core

Исторический review. Последующее разрешение пользователя и выполненная активация:
[SSO deployment](AUTH-SSO-DEPLOYMENT-20260919.md).

Дата: 2026-09-18. Реализация подготовлена для review, **не развёрнута**.
Контракт: Auth Core `codex/multi-service-sso`, commit
`9003f5ff71fb9505e412383c89d3f5f29ee01801`, `docs/multi-service-sso.md` и `server/sso.mjs`.
Это внутренний SSO-протокол, не OAuth/OIDC. Принятие владельцем не подтверждено.

## Конфигурация и адреса для согласования

- client_id / service: `crypto.robot`.
- Предлагаемый Auth origin: `https://auth.vpn`.
- Предлагаемый consumer origin: `https://crypto.robot.vpn`.
- Точный callback: `https://crypto.robot.vpn/auth/callback`.
- Ссылка каталога Auth: `https://crypto.robot.vpn/auth/login`, новая вкладка с `noopener`.

Адреса, TLS и регистрация клиента не проверены и требуют согласования владельцев.
Каталог Auth в этом проекте не изменялся. Текущий HTTP endpoint для SSO непригоден.
Поддерживается размещение в корне origin; существующий вариант `/crypto/` не является
эквивалентным callback и потребует отдельной адаптации.

По умолчанию `AUTH_CORE_ENABLED=false`. Для включения нужны точные HTTPS
`AUTH_CORE_ORIGIN`, `AUTH_CORE_APP_ORIGIN`, отдельный `AUTH_CORE_CLIENT_SECRET`
и список UUID `AUTH_CORE_VIEWER_IDS` через запятую. Пустой список никого не допускает.
Секрет клиента не создавался, не читался и не provisioned. Он должен поступить через
существующий механизм секретов, отдельно от operator Basic Auth.

## Маршруты и права

- `GET /auth/login`: browser-bound state, PKCE S256, pending transaction на 10 минут.
- `GET /auth/callback`: одноразовое потребление локальной транзакции, server-side exchange,
  introspection и проверка локального допуска. Срок кода 60 секунд обеспечивает Auth;
  offline fake проверяет этот предел и одноразовость.
- `GET /auth/session`: actor `(configured Auth origin, user.id)`, роль viewer, CSRF token.
- `POST /auth/logout`: точный Origin и CSRF, очистка локальной сессии, introspect/revoke;
  при сбое отзыва возвращается 503 с `localLoggedOut:true, revoked:false`.
- Viewer GET/HEAD allowlist: `/api/status`, `/api/market/tickers`, `/api/risk-budget`,
  `/api/journal`, `/api/positions`, `/api/risk-events`, `/api/auto-trader/status`.
  Также доступны `/`, собранные JS/CSS assets и `/auth/session`.
- Viewer запрещены все мутации, runtime-config, private Binance API и неизвестные API.
  UI скрывает форму paper order и Run scan.
- При SSO включённом существующие API имеют отдельные `/operator/api/...` aliases,
  защищённые прежним Basic Auth. `GET /operator/auth/session` выдаёт отдельную cookie
  и CSRF token. Для трёх разрешённых POST нужны Basic Auth, cookie, точный Origin
  и `X-CSRF-Token`. Live-unlock по-прежнему возвращает 423.
  Отдельной operator UI в SSO-режиме пока нет; сохранён операционный API.
- `/health` и `/favicon.ico` публичны. При выключенном SSO остаётся прежний Basic режим.

Membership подтверждает только доступ к сервису. Локальный UUID allowlist даёт
только чтение общего paper-журнала; это не модель владения портфелем и не право
торговать. Headers role/owner_id, имя и email не участвуют в авторизации.
Права оператора не выводятся из Auth membership и не доступны через fallback.

## Сессии и ограничения

На каждом защищённом SSO-запросе выполняется introspection без кэша: active,
точный service, UUID subject, expiresAt, неизменность subject. Timeout 5 секунд,
ошибки и malformed response закрывают доступ. Операционный namespace имеет свою
независимую Basic-аутентификацию.

Upstream token хранится только в памяти сервера. Браузер получает отдельную случайную
host-only `__Host-` cookie с HttpOnly, Secure, SameSite=Lax. Сессия ограничена 8 часами
и сроком Auth. Перезапуск сбрасывает локальные сессии; несколько реплик без общего
хранилища не поддерживаются. Карты ограничены 1000 записями каждого типа.
Отзыв родительской сессии/membership учитывается при следующей introspection;
это не отменяет уже выполняющийся запрос. Logout не завершает общую Auth-сессию.

Логгер приложения исключает query string и headers. Перед rollout обязательна
проверка proxy/access/error logging: callback query нельзя сохранять на proxy.

## Проверки

`npm test`: 68 passed, 15 PostgreSQL integration tests skipped без тестовой БД.
Включены 28 Auth-тестов: success, PKCE/state/cookies, replay/expiry, client/secret/
callback isolation, membership, local allowlist, malformed/timeout, revocation,
CSRF/logout, запрет viewer мутаций и проверка реального Fastify operator namespace.
`npm run lint` и `npm run build` прошли.

Playwright использует только локальный Vite и синтетические API: viewer без формы
ордера и Run scan, operator с прежними controls, переход в Paper Trading,
desktop/mobile screenshots. Browser plugin недоступен. Реальный Auth, production
DB, scan, заявки и биржевые операции не использовались.

## Совместный rollout / rollback

1. Владельцы подтверждают origins/callback, доступность TLS, scope общего журнала,
   UUID allowlist и приемлемость operator API без отдельного UI.
2. Отдельно разрешают provisioning клиента, membership и доставку секрета.
3. Проверяют proxy logging, HTTPS-only доступ и закрытие обходных HTTP entrypoints.
4. Согласованно развёртывают совместимую ветку Auth и consumer, затем включают флаг
   и выполняют отдельно разрешённый smoke test. Этот запрос этих действий не разрешает.
5. Rollback выполняют явно: закрыть SSO ingress, отозвать service sessions,
   восстановить предыдущий build/config и проверенный Basic operator ingress.
   Не открывать прежний Basic API для всех viewer и не включать fallback при сбое Auth.

Открыто: owner acceptance, окончательные DNS/TLS/callback, provisioning, UUID mapping,
proxy log policy, необходимость отдельного operator UI и последующий live smoke.
