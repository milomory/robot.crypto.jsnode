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
