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

## Task 6: Replaceable multimodal recognition and strict payment extraction

RED — `pnpm --filter @auto-reimbursement/api test test/ai.test.ts` exited 1 before production edits because Vitest could not resolve the expected missing `../src/ai/openai-compatible.js` module.

GREEN — after adding the provider-neutral interfaces, strict Zod validator, prompt, OpenAI-compatible adapter and safe status route, `pnpm --filter @auto-reimbursement/api test test/ai.test.ts` exited 0 with 15/15 tests. The suite uses only a fetch-boundary fake with complete real `Response` objects and asserts adapter outputs, errors, endpoint joining, request headers/body, image data URLs and response decoding.

Coverage — validation tests cover the exact ten-category enum, shared `parseFen` money rules and overflow, leap-day-aware calendar dates, finite inclusive confidence bounds, ambiguous/null consistency, field and array caps, root/nested unknown keys and non-object inputs. Adapter tests cover configured and unconfigured status, trailing-slash endpoint joining, model/temperature/messages/data URL payloads, upstream-only Authorization, string versus unknown content forms, terminal missing-config/401/403 behavior, and retryability for 429, 5xx, network, timeout, malformed transport JSON, malformed content JSON and schema-invalid JSON. Error and status assertions verify that credentials, model, URL details and upstream bodies are never exposed.

Implementation — `ReceiptAnalyzer` and `AiImage` depend only on shared `Analysis`/`ImageRef` contracts. Vendor response traversal remains private to the one adapter. Successful content is parsed as strict JSON and validated without coercing categories, amounts or dates. The adapter uses `AbortSignal.timeout(45000)`, maps failures to code-only `AiError` values, and never reads error bodies. `GET /api/ai/status` returns only `{configured,provider}` with the constant provider label `openai-compatible`; receipt uploads remain unchanged and never invoke analysis.

Verification — the final focused command exited 0 with 15/15 tests. `pnpm test` exited 0 with 75/75 workspace tests (contracts 25, API 49, web 1), and `pnpm typecheck` exited 0 for all three workspace packages. `git diff --check` exited 0 with only informational Windows line-ending notices.

Scope review — changes are limited to the Task 6 allowlist and this log: AI types/prompt/validation/adapter code, the status route, the AI test suite, Zod manifest/lockfile changes, and this implementation record. No analyzer call was added to upload, and no queue, decision, learning, persistence schema, refund or UI behavior was implemented. The explicit no-subagent instruction required local review of vendor isolation, URL joining, auth secrecy, schema/date strictness, error mapping and status response shape.

Commit — `feat: add replaceable receipt analysis adapter`; its immutable SHA is recorded in the Task 6 report immediately after Git creates the commit.

## Task 7: Durable recognition queue, bounded concurrency and retries

RED — `pnpm --filter @auto-reimbursement/api test test/queue.test.ts` exited 1 before production edits because Vitest could not resolve the expected missing `../src/queue.js` module. The queue scheduler, progress calculation, retry route and lifecycle wiring did not exist.

GREEN — after implementing the durable scheduler and API lifecycle, `pnpm --filter @auto-reimbursement/api test test/queue.test.ts` exited 0 with 12/12 tests. An intermediate run exposed a test-boundary issue: real asynchronous file reads completed after the virtual clock had already advanced, causing retries to be scheduled beyond the advanced time. Condition-based real-I/O waits were added while retaining fake timers for the exact 1-second and 3-second retry delays.

Coverage — the queue suite uses real SQLite stores, real indexed temporary PNG files, real Sharp fingerprints, real multipart upload routes and fake timers. It verifies a four-call active bound across five receipts, exactly three total attempts, persisted attempts before adapter invocation, 1-second then 3-second delays, no transaction across analyzer/callback awaits, terminal versus transient `AiError`, restart recovery from `nextAttemptAt`, attempt-exhausted recovery without an adapter call, Task 7's temporary successful-analysis pending state, completion-order independence from `uploadOrder`, stop/drain timer behavior, missing index/file handling, retry 404/409 guards and reset, progress restricted to requested unique IDs, upload and confirm-distinct enqueue, and exact/suspected duplicate exclusion before analyzer invocation.

Implementation — `createQueue` scans durable recognizing rows in upload order, reserves active IDs synchronously, bounds work by configured concurrency, and maintains one earliest-due timer. It increments attempts in a synchronous transaction before reading the indexed original and awaiting the provider. Retryable adapter failures persist `nextAttemptAt`; terminal or exhausted failures become pending with `api_failed`. `stop` disables launches, clears the timer and waits for active calls; `drain` waits for active and scheduled retry work. `persistAnalysis` is the intentional Task 7 callback: it stores the original analysis and parsed `recognizedFen`, then leaves the row pending with `amount_uncertain` and `category_uncertain` for Task 8 to replace. No credentials, image base64 or upstream bodies are logged.

Integration — accepted upload IDs and confirmed-distinct recognizing IDs wake the queue. Retry is allowed only for pending `api_failed` rows and resets attempts, due time and the failure reason before enqueue. Progress counts only existing receipts among the requested unique IDs. Production constructs the replaceable analyzer and queue once, resumes durable work on startup, and closes the HTTP server, queue and store in safe shutdown order.

Self-review — active-set slot reservation occurs before any asynchronous boundary; completion callbacks cannot oversubscribe the configured bound. Timer clearing and re-scheduling follows each launch, completion and stop. No Store transaction contains an `await`. Failure state is based on the persisted attempt count. HTTP mappings are 404 for missing retry IDs and 409 for ineligible states. Missing, deleted, wrongly owned or path-mismatched original indexes never reach the analyzer. Upload order fields are never rewritten. The implementation contains no Task 8 confidence release, rule learning, refund, UI or unrelated behavior.

Verification — the focused queue suite exited 0 with 12/12 tests. `pnpm --filter @auto-reimbursement/api test` exited 0 with 63/63 API tests, `pnpm --filter @auto-reimbursement/api typecheck` exited 0, and `git diff --check` exited 0 with only informational Windows line-ending notices. Final fresh workspace-wide test and typecheck evidence is recorded in the Task 7 report.

Commit — `feat: queue receipt analysis with durable retries`; its immutable SHA is recorded in the Task 7 report immediately after Git creates the commit.

## Task 8: Confidence decisions and automatic release

RED — `pnpm --filter @auto-reimbursement/api test test/decision.test.ts` exited 1 before production edits because Vitest could not resolve the expected missing `../src/decision.js` module.

GREEN — `pnpm --filter @auto-reimbursement/api test test/decision.test.ts` exited 0 with 17/17 tests. The decision suite uses real decision and SQLite store behavior to cover default high confidence release; strict ambiguity/null/floor ordering; boundary confidences; normalized merchant and keyword strong-rule matches; medium release only with an agreeing strong rule; unconfirmed-rule rejection; category/rule conflicts before high release; no amount inference; duplicate refinement veto; lifecycle guards; and transactional rollback on invalid amounts.

Implementation — `decide` evaluates ambiguity, null fields, medium floors, matching strong-rule conflicts, high thresholds, then medium rule-supported release in that order. Its local NFKC normalizer keeps merchant and keyword matching isolated until Task 9. `applyAnalysis` performs the recognition-to-ready/pending transition in one Store transaction, persists original analysis plus parsed recognized/paid amounts and extracted fields, re-runs duplicate refinement, deduplicates pending reasons, and makes duplicate evidence veto automatic release. No ready row can retain a null amount or category. Production now calls `applyAnalysis`; the Task 7 temporary callback remains only for its existing queue coverage.

Verification — final focused, API, workspace test, and typecheck evidence is recorded in the Task 8 report after the commit is created. `git diff --check` exited 0 before commit.

## Task 9: Local correction learning and editable rules

RED — `pnpm --filter @auto-reimbursement/api test test/learning.test.ts` exited 1 before production edits because Vitest could not resolve the missing `../src/learning.js` module.

GREEN — the focused learning suite exited 0 with 10/10 tests. It verifies three consistent corrections promote a normalized merchant rule; a conflicting correction resets its confirmation count; blank feature data yields no rule; repeated confirmation of one receipt/category is counted only once; keyword fallback is normalized; and explicit receipt confirmation, rule CRUD, invalid categories, archived edits, and unresolved duplicates follow their required guards.

Implementation — schema version 2 adds a vendor-neutral `corrections` SQLite table, using `INSERT OR IGNORE` for one audit record per receipt/category. Local learning prefers a normalized merchant, otherwise the first usable AI keyword, and persists the original AI category, latest user category, count, strong flag and timestamp in ordinary rules. Receipt PATCH remains pending; explicit confirmation validates mutable state, final amount/category and duplicate resolution, preserves the original analysis, clears pending reasons, then records the correction in the same transaction. Rules are editable through GET/PUT/DELETE API endpoints, and decision matching now uses the shared feature normalizer.

Verification — `pnpm --filter @auto-reimbursement/api test` exited 0 with 92/92 tests and `pnpm --filter @auto-reimbursement/api typecheck` exited 0. `git diff --check` exited 0 with only informational line-ending notices.
