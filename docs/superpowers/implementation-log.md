# Implementation log

## Task 1: Project skeleton and test environment

Task 1 was completed before this plan recovery; historical RED output is not available in this document. Its already-reviewed implementation state is preserved.

## Task 2: Backend-only configuration and local data directories

RED — `pnpm --filter @auto-reimbursement/api test test/config.test.ts` exited 1 before production edits. Vitest could not resolve `../src/config.js`, as expected for the missing configuration module.

GREEN — `pnpm --filter @auto-reimbursement/api test test/config.test.ts` exited 0: 1 test passed with no warnings.

Verification — `pnpm test` exited 0: API 2/2 tests and web 1/1 test passed with no warnings. `pnpm typecheck` exited 0 for both workspace packages. `git check-ignore data/probe .env` reported both paths; `git check-ignore .env.example` exited 1, confirming the example remains tracked.

## Task 3: Shared contracts, money invariants and SQLite persistence

RED — `pnpm --filter @auto-reimbursement/api test test/db.test.ts` exited 1 before production edits because Vitest could not resolve the expected missing `../src/db.js` module. After workspace wiring, `pnpm --filter @auto-reimbursement/contracts test` exited 1 because the expected `./index` money exports did not exist. Mutation RED for synchronous transactions and the table whitelist exited 1 with 2 expected failures: Promise callbacks committed instead of throwing `ASYNC_TRANSACTION`, and a forged table name reached SQLite instead of throwing `INVALID_TABLE`.

GREEN — `pnpm --filter @auto-reimbursement/contracts test` exited 0 with 20/20 tests. `pnpm --filter @auto-reimbursement/api test test/db.test.ts` exited 0 with 8/8 tests using real SQLite, real disk reopen, and the SQLite backup API.

Verification — `pnpm test` exited 0 with 31/31 tests (contracts 20, API 10, web 1) and no warnings or failures. `pnpm typecheck` exited 0 for contracts, API, and web. `git diff --check` exited 0; Git reported only informational Windows line-ending conversion notices.

Commit — `feat: persist reimbursement records in sqlite`; its immutable SHA is recorded in the Task 3 report immediately after Git creates the commit.
