# Публикация актуального кода для ревью — 1 октября 2026

[Ветка codex/mexc-okx](https://github.com/milomory/robot.crypto.jsnode/tree/codex/mexc-okx)
опубликована. [Точки входа для ревью](https://github.com/milomory/robot.crypto.jsnode/blob/codex/mexc-okx/PUBLIC-REVIEW.md).

- Исходный локальный снимок: `34758c4960cbaa76e564ea641731a55014f5e5f3`.
- Публичный review commit: `4018cf346fc8952d356d59663d129ded77c1ca4e`.
- Его единственный parent: `4345d0c9f868e830bb2b2034d0b78864c4309575`;
  GitHub main остался на этой прежней версии. Промежуточная локальная история
  не опубликована, локальный main не переписан.
- Push, `ls-remote` и анонимный GitHub API подтвердили commit; blob
  `PUBLIC-REVIEW.md` совпал с подготовленной веткой. Web-reader дал cache miss
  для только что созданной страницы; подтверждение выполнено прямым API.

## Состав снимка

561 tracked-файл. Source/tests/fixtures: 275 сверены, 274 побайтно совпадают,
в `src/accounts/account-binding.ts` заменены только ссылки private wiring.
В ops сохранена логика с согласованными заглушками environment references.
Приватные account captures, receipts и смешанные operational notes исключены;
Markdown-заглушки указывают на это явно. План и exporter использовали только Git
objects — untracked `docs/AUTH-CORE-INTEGRATION-REQUEST.md` не попал в публикацию.

Независимый аудит и redacted pattern scan не нашли новых account UID/Auth subject,
реальных ключей и конкретных ссылок на записи ключницы. Исторические уже публичные
Auth/HTTPS документы не переписывались. Специализированных gitleaks/trufflehog нет;
это ограничение проверки отмечено в публичном документе. Pattern scan не считается
абсолютным доказательством отсутствия любой чувствительной информации.

Ветка предназначена для review и тестов, **не для production deploy**: заглушки
вместо private references и receipts не являются действительной конфигурацией.
Полная исходная история и рабочие production bindings остаются в локальном проекте.

## Проверки и следующий шаг

Исходники и экспорт отдельно прошли 3 956 тестов, 15 прежних PostgreSQL skips;
API/UI build PASS. Новые D0 тесты — 284, строгая типизация PASS. В экспортированной
копии account-selection Python tests — 10 PASS. Финальные две privacy-замены
и whitespace-правка затрагивали только docs, после проверок кода.

[D0a](DERIVATIVES-PUBLIC-D0.md): восемь публичных GET MEXC/OKX BTC/ETH приняты,
публичный raw fixture + manifest и replay сохранены. Это разовое наблюдение,
не новая фоновая кампания. Общая сетка BTC 0.0001 BTC, ETH 0.01 ETH; прогноз funding
не начисленный доход. Net edge, margin/account eligibility не подтверждены.

Далее D0b — единицы/время стаканов, mark/index/OI и история funding; затем D1
по [плану](DERIVATIVES-OPPORTUNITY-PLAN.md). Новые ключи не нужны. Торговая блокировка,
основной робот, БД, Spot observer, сделки и перемещения средств не менялись.


## Полный D0b и MEXC WS source-time

Source `f4b2b882eece55efc674382e2934b8f7d5886575` опубликован отдельным публичным
review-коммитом `d25bdf1f890c9b40fce4297cb34fa96e9dde0b4a`, parent `b342faa`.
Анонимный GitHub API подтвердил точный commit ветки и blob `PUBLIC-REVIEW.md`.

- Полный D0b: 24/24 GET BTC/ETH и replay приняты на том же OKX origin.
  Причина исторического Python 403 не установлена.
- MEXC WS: 10 последовательных BTC deltas с matching-engine cts; полная книга
  ещё не реконструирована. Следующий этап — fresh bootstrap, continuous updates,
  известная граница глубины, затем ETH/Spot и D1 budget.
- Source: 4 574 PASS, 15 прежних PG skips; build/strict types PASS.
- Export: 902 market-data tests и API/UI build PASS. 298 source/tests/fixtures
  сверены: 297 byte-identical, один файл только с прежними private ref placeholders.
- Первоначальный массовый git add был отклонён auto-review из-за риска захватить
  пользовательский Auth-документ. Read-only проверка доказала отсутствие этого
  файла в review-worktree; использован явный список 23 файлов. Повторный scoped
  commit/push принят. Пользовательский файл остался untracked в исходном checkout.

[Evidence](evidence/derivatives-d0b-20261001/depth-source-publication.json).
Main, private history и production runtime сохранены.
