# Task 20 report: end-to-end validation and acceptance fixtures

## Implemented

Added deterministic synthetic receipt fixtures, a SHA-256 keyed fake analyzer,
and an isolated Playwright runtime using system Chrome, a temporary loopback API
store, and a Vite proxy configured only through `API_PROXY_TARGET`. The E2E
workflow covers accessible upload, exception correction, pool aggregation,
partial refund and evidence, selected batch generation, option persistence,
export immutability, and the exported PDF endpoint.

Fixture generation produced 50 manifest entries backed by 49 synthetic images:
35 normal, 5 ambiguous, 3 low-confidence category, 2 transient, 1 terminal,
1 exact renamed duplicate, 1 cropped suspected duplicate, and 2 manual
correction examples. It verifies normal dHash separation and the intended
cropped-pair match.

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
