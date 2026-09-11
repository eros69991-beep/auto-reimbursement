# Acceptance validation

## Synthetic fixture set

`pnpm fixtures` generates 53 labeled PNG files from `e2e/fixtures/manifest.json`.
The first run has 50 records: 35 normal high-confidence receipts across the ten
categories and representative layouts; 5 amount-ambiguous receipts; 3
low-category-confidence receipts; 2 transient failures; 1 terminal failure; 1
renamed exact duplicate; 1 cropped suspected duplicate; and 2 manual-correction
examples. A second run has 3 same-supplier corrections and a later
medium-confidence receipt. The renamed duplicate intentionally reuses `normal-01.png`. The
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

The direct loopback acceptance contract uploads every first-run
fixture through the real HTTP application. It asserts the 49 accepted rows,
the exact duplicate rejection, every manifest amount/category/status/reason,
both transient retry counts, the terminal failure, the cropped duplicate's
pre-analysis interception, and the 51-file HTTP 413 limit. It then runs the
three corrections, verifies the strong supplier rule, and verifies the
medium-confidence receipt auto-releases. The representative system-Chrome
workflow separately waits for the refund-evidence upload before batch creation
and asserts the 80.00 refund, evidence snapshot, draft-PDF response, option
save, export, and saved-PDF response. The API PDF suite remains the source of
text/page-order extraction evidence for original/refund attachment sequencing.

An additional disposable-loopback release contract verifies hostile-origin
mutation rejection, receipt-owned historical-duplicate evidence, duplicate
override re-recognition, and export/archive/unarchive/explicit-original-cleanup
with PDF and structured-backup retention. These are synthetic integration
checks; they do not establish real receipt-recognition accuracy.

The initial acceptance run exposed synchronization defects in the test itself:
it could observe the initial `识别中：0` before upload completion and it could
navigate before asynchronous confirmation completed. The test now waits for the
upload result and for the pending card to be removed. It also validates the
actual PDF-link response rather than expecting a browser download event, since
the product exports in place and provides an open/download link.

## Evidence limitations

No consented, human-labeled real receipt images were supplied. Real-recognition
accuracy, auto-release rate, exception interception rate, wall-clock
upload-to-PDF comparison, and user manual-baseline/time-saved estimate remain
unperformed. The synthetic tests exercise the specified lifecycle branches,
not those real-world metrics. Paper-form review is a structural visual check;
it is not a physical measurement or a claim of millimetre-perfect fidelity.
Visual screenshots and rendered-PDF review artifacts are local QA material and
are not committed.
