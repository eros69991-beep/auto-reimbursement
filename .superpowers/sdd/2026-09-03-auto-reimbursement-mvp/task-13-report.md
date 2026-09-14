# Task 13 report: Programmatic Chinese uppercase currency

## RED

`pnpm --filter @auto-reimbursement/api test test/uppercase.test.ts` exited 1 before production edits. Vitest failed to resolve the expected missing `../src/uppercase.js` module, so no tests were collected.

## Implementation

Added `apps/api/src/uppercase.ts` exporting `chineseUppercase(fen: number): string`. Validation delegates to `formatFen` before arithmetic, preserving its integer/range contract and `INVALID_AMOUNT` errors. Yuan is converted with four-digit sections and 亿/万/unit groups; decimal output handles 角、分 and 整 with the required zero insertion rules.

Added a table-driven suite covering the specified examples, large section boundaries (`10000000100` and `100100000` fen), and negative, fractional, overflow, non-finite and NaN inputs.

## GREEN verification

- `pnpm --filter @auto-reimbursement/api test test/uppercase.test.ts` exited 0: 18/18 tests passed.
- `pnpm --filter @auto-reimbursement/api typecheck` exited 0.
- `pnpm --filter @auto-reimbursement/api test` exited 0: 142/142 API tests passed across 13 files.
- Manual boundary probe covered `100000`, `100100`, `101000`, `1000000`, `10000000`, `100000000`, and `999999999999` fen.
- `git diff --check` passed before commit.

## Scope

Changes are limited to the Task 13 formatter, its tests, this report, and the implementation log. No Task 14+ files or behavior were changed.

## Commit

Commit SHA is recorded here after creating the required commit.
