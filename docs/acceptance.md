# Acceptance validation

## Synthetic fixture set

`pnpm fixtures` generates 49 labeled PNG files from `e2e/fixtures/manifest.json`.
The manifest has 50 records: 35 normal high-confidence receipts across the ten
categories and representative layouts; 5 amount-ambiguous receipts; 3
low-category-confidence receipts; 2 transient failures; 1 terminal failure; 1
renamed exact duplicate; 1 cropped suspected duplicate; and 2 manual-correction
examples. The renamed duplicate intentionally reuses `normal-01.png`. The
generator rejects normal-fixture dHash collisions at the suspicion threshold
and verifies the cropped pair remains within that threshold. All images are
synthetic and contain no receipt data.

## Commands and results

Run from the repository root:

```sh
pnpm fixtures
pnpm test:e2e
pnpm test
pnpm typecheck
pnpm --filter @auto-reimbursement/web build
```

On 2026-09-11, fixture generation completed successfully and the isolated
system-Chrome Playwright scenario passed in 6.4 seconds. It uses a disposable
loopback API composition root with deterministic SHA-256 fixture responses,
then validates upload, exception correction, pool totals, partial refund and
refund evidence, explicit receipt selection, batch creation, option saving,
PDF export, and an HTTP 200 `application/pdf` response from the immutable
export link. The full unit suite, typecheck, and production web build are
recorded with their final rerun in the Task 20 report.

The initial acceptance run exposed synchronization defects in the test itself:
it could observe the initial `识别中：0` before upload completion and it could
navigate before asynchronous confirmation completed. The test now waits for the
upload result and for the pending card to be removed. It also validates the
actual PDF-link response rather than expecting a browser download event, since
the product exports in place and provides an open/download link.

## Evidence limitations

No consented, human-labeled real receipt images were supplied. Real-recognition
accuracy, auto-release rate, exception interception rate, wall-clock
upload-to-PDF comparison, user manual-baseline/time-saved estimate, and paper
form geometry comparison were therefore not performed. This project is not
validated on real receipts, and no physical-size fidelity is claimed from the
reference photos. Visual screenshots and rendered-PDF review artifacts are
local QA material and are not committed.
