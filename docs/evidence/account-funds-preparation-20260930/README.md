# Account funds preparation — local acceptance, 30 September 2026

[Checks and source hashes](checks.json): **3,017 tests passed**, 15 existing
PostgreSQL skips; API/UI build and strict typing of new tests passed.
293 new tests cover evidence, fee arithmetic, integrated draft admission, private
CAS journal and all five offline CLI commands.

Independent review found spendable BTC was incorrectly reused for inventory risk.
The final implementation separates ownership from availability and the regression
case includes two held BTC despite zero spendable BTC.

All test accounts, responses, key material and fees are synthetic. The CLI
round-trip, two-process race, forced SIGKILL, failed fsync and large capture tests
use private temporary files. No actual account archive or secret was accessed.
There was no server deployment, exchange call, source push or trading action.
Fee provenance and production account-global authority remain false.

[Contract, commands, limitations and next work](../../ACCOUNT-FUNDS-PREPARATION.md).
