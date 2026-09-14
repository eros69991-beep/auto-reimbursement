# Task 20 report: end-to-end validation and acceptance fixtures

## Implemented

Added deterministic synthetic receipt fixtures, a SHA-256 keyed fake analyzer,
and an isolated Playwright runtime using system Chrome, a temporary loopback API
store, and a Vite proxy configured only through `API_PROXY_TARGET`. The E2E
workflow covers accessible upload, exception correction, pool aggregation,
partial refund and evidence, selected batch generation, option persistence,
export immutability, and the exported PDF endpoint.

The original fixture run had 50 manifest entries backed by 49 synthetic images:
35 normal, 5 ambiguous, 3 low-confidence category, 2 transient, 1 terminal,
1 exact renamed duplicate, 1 cropped suspected duplicate, and 2 manual
correction examples. It verifies normal dHash separation and the intended
cropped-pair match.

## Review fix round 1

The fixture harness now executes its data rather than only using two images in
the browser path. A disposable direct-loopback test uploads every first-run
record through the real API, checks all expected amount/category/outcome/reason
values, verifies the exact duplicate is rejected before analysis, checks both
retry counters and the terminal failure, and asserts the 51-file HTTP 413
limit. The cropped suspected duplicate is accurately modeled as pending before
analysis, so its amount/category expectation is null.

The manifest now includes a separate learning run with three consecutive
same-supplier corrections and a matching medium-confidence receipt. The test
confirms the three corrections and verifies that the resulting strong rule
releases the medium-confidence record. The browser test waits for the refund
image HTTP response, snapshots the selected receipt's 80.00 refund and one
refund image in the batch, and verifies the draft PDF endpoint before export.

The second run adds four synthetic records, for 54 records backed by 53 images.
The API PDF test remains the source of extracted attachment-page order
assertions; the browser test checks the same generated draft PDF response but
does not duplicate PDF text extraction.

Fresh verification for this review fix: `pnpm fixtures` generated 53 synthetic
fixture records; `pnpm test:e2e` passed 2/2 in 9.5 seconds; `pnpm test` passed
206 tests; `pnpm typecheck` and `pnpm --filter @auto-reimbursement/web build`
both exited 0.

## RED and GREEN

The initial browser run failed because the scenario matched the upload page's
initial zero progress and navigated before confirmation had completed. A later
run proved that export is an in-page operation followed by a PDF link, not a
browser download event. The scenario now waits for observable completion at
each asynchronous boundary and checks the exported link's 200
`application/pdf` response. `pnpm test:e2e` passed in 6.4 seconds with the
system Chrome channel.

## Operational handoff

README now documents backend-only vision-provider configuration, local data,
the structured-backup media limitation, safe shutdown, restore into a stopped
fresh data directory, and separately restoring indexed media from the original
copy. `docs/acceptance.md` records commands, fixture counts, synthetic-only
status, and missing real-world evidence.

## Limits

No consented human-labeled receipt corpus was supplied, so no real-image
recognition metrics, manual time comparison, or paper-form visual comparison is
claimed. Local screenshots/PDF-render QA artifacts and pre-existing `tmp/` /
`apps/api/tmp/` directories remain untracked.
