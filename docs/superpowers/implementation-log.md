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

## Task 4: Ordered image upload and immutable local storage

RED — `pnpm --filter @auto-reimbursement/api test test/upload.test.ts` exited 1 before production edits because Vitest could not resolve the expected missing `../src/receipts.js` module. No upload production module or route existed at that point.

GREEN — `pnpm --filter @auto-reimbursement/api test test/upload.test.ts` exited 0 with 9/9 tests. The first implementation run exposed and then fixed an image response header bug: Express treated the slash-containing indexed relative path as a literal content type; using only its trusted generated extension made the focused suite pass.

Coverage — the focused suite uses real Sharp-generated/decoded pixels, real Multer multipart parsing, real Supertest requests, a real in-memory SQLite Store, and real temporary-disk bytes. It verifies byte-for-byte preservation and SHA-256, multipart/SQLite order, exact 50-file acceptance and 51-file HTTP 413 rejection, decoded format over claimed MIME/extension, malformed per-item rejection without consuming order, a greater-than-20-MiB limit, a greater-than-40-million-pixel limit, browser-name traversal irrelevance, zero-file rejection, health-only `createApp()`, the 1 MiB JSON limit, same-transaction Receipt/FileIndexEntry writes, exact-orphan cleanup that preserves a sentinel file, sanitized internal errors, and indexed live/missing/deleted image responses.

Implementation — original bytes are written once with `flag: 'wx'` beneath generated UUID month/kind paths and are never recompressed. Validation completes before any path is created. Receipt upload is sequential; `nextOrder()`, the recognizing Receipt, and its FileIndexEntry are persisted in one synchronous transaction. A transaction failure unlinks only the exact newly created path. Image reads require a live file-index row and resolve it through `safePath`; no static directory is exposed. Multer bounds memory to 50 files at 20 MiB each, which can still require substantial local RAM at the maximum request size. The server opens one Store and closes it when the HTTP server shuts down, while dependency-free app creation retains isolated health behavior.

Verification — `pnpm test` exited 0 with 46/46 tests (contracts 25, API 20, web 1), with no failures or runtime warnings. `pnpm typecheck` exited 0 for contracts, API, and web.

Scope review — changes are limited to the Task 4 allowlist: upload/storage/routes/app/server code, the upload integration suite, the API manifest and pnpm lockfile, and this log. No duplicate detection, recognition/AI, queue, frontend, schema expansion, refund, or later-task behavior was added.

Commit — `feat: upload immutable receipt images in order`; its immutable SHA is recorded in the Task 4 report immediately after Git creates the commit.

## Task 5: Historical exact and suspected duplicate detection before AI

RED — `pnpm --filter @auto-reimbursement/api test test/duplicates.test.ts` exited 1 before production edits because Vitest could not resolve the expected missing `../src/duplicates.js` module.

GREEN — the first focused duplicate/upload run exposed two issues and exited 1: a suspected-order test accidentally reused the helper's default SHA-256 and therefore exercised exact matching, while the new pre-transaction Store lookup occurred outside Task 4's orphan-cleanup boundary. After giving the fixture distinct SHA-256 values and widening that cleanup guard, `pnpm --filter @auto-reimbursement/api test test/duplicates.test.ts test/upload.test.ts` exited 0 with 23/23 tests. `pnpm --filter @auto-reimbursement/api test` then exited 0 with 34/34 API tests, and its package typecheck exited 0.

Verification — the final fresh focused duplicate/upload command exited 0 with 23/23 tests. `pnpm test` exited 0 with 60/60 workspace tests (contracts 25, API 34, web 1), and `pnpm typecheck` exited 0 for all three workspace packages.

Coverage — tests use real Sharp-decoded gradient, recompressed PNG, checkerboard, and seeded pixel images; real multipart requests; real temporary disk bytes; and real SQLite transactions. They cover byte SHA-256, 16-digit 64-bit dHash, altered PNG compression, visually unrelated checkerboards, empty hashes, self-exclusion, deterministic ordering, archived/deleted history, exact upload rejection with `duplicateId`, indexed historical evidence, suspected pending state, atomic race recheck, orphan cleanup, metadata-plus-image refinement at Hamming distance 10, local NFKC merchant normalization, override behavior, direct confirmation transitions, and HTTP 404/409 mappings.

Implementation — `storeImage` retains bounded metadata and complete raw decoding, then computes fingerprints before directory/file persistence and writes the untouched bytes exclusively. Upload performs an early historical exact check and repeats duplicate discovery inside the Receipt/FileIndexEntry transaction; a race loser or ordinary exact duplicate removes only its newly created unindexed path. Suspected visual matches persist as pending with `suspected_duplicate` and deterministic evidence IDs. Historical search includes archived and deleted receipts, ignores empty/malformed hashes and the same indexed image, and never invokes `BigInt` before 16-hex validation. `confirmDistinct` clears duplicate state, records the override, and resumes recognition when analysis is absent. Refinement requires the image-distance threshold together with paid amount, normalized nonempty merchant, and nonnull equal date; metadata alone never matches.

Scope review — changes are limited to the Task 5 allowlist and this log. Task 4's full decode, zero multipart-field limit, exclusive-write ownership cleanup, immutable original bytes, and indexed image access remain covered. No AI adapter, recognition queue, decision engine, learning module, schema change, refund behavior, or later-task functionality was added. The no-subagent instruction prevented dispatching the review skill's reviewer, so the BigInt/hash validation, deterministic order, cleanup paths, concurrent transaction window, historical immutability, response shape, and HTTP mapping review was performed locally.

Commit — `feat: block duplicate receipts across history`; its immutable SHA is recorded in the Task 5 report immediately after Git creates the commit.
