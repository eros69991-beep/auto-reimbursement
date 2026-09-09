# Task 16 report: full preview PDFs with ordered refund evidence

## Implementation

Added deterministic attachment ordering for every sheet: receipt snapshots follow stored group order, each original precedes its stored refund evidence, and labels include category, original/refund/net amounts where applicable, and the evidence kind. Attachment pages are portrait A4 with a 12 mm margin, an 18 mm label area, and an aspect-fit image region. WebP is decoded to PNG in render memory only; indexed source bytes are never rewritten.

The renderer now emits each form immediately followed by its attachment pages, reads only safe indexed paths, and rejects unavailable required receipt evidence as `MISSING_ATTACHMENT:<receiptId>`. It supports both text and image signer modes. Draft preview renders these same pages; export writes an exclusively-created temporary file, atomically renames it to a UUID PDF, and records the immutable path and SHA-256 inside the batch transaction. Existing exports are returned unchanged. Preview and saved-PDF routes serve the immutable saved bytes after export.

## Verification and visual QA

- `pnpm --filter @auto-reimbursement/api test test/pdf.test.ts` exited 0 with 2/2 tests.
- `pnpm --filter @auto-reimbursement/api typecheck` exited 0.
- `pnpm test` exited 0 with 180 tests: 25 contracts, 155 API, and 1 web.
- `pnpm typecheck` and `git diff --check` exited 0.
- A freshly rendered five-page QA fixture was rasterized with `pdftoppm -r 144 -png -f 1 -l 5 tmp/pdfs/task16-qa.pdf tmp/pdfs/task16-qa`. All pages were inspected: form 1, original evidence, refund evidence, form 2, and original evidence. Labels were legible, Chinese glyphs rendered, margins and reserved label bands were preserved, and the aspect-fit images showed no clipping, overlap, or stretching. Poppler emitted its known non-fatal `nameToUnicode` path warnings while producing the PNGs.

## Scope and concern

The untracked `tmp/` and `apps/api/tmp/` fixtures, scripts, PDFs, and PNGs are QA-only and intentionally excluded from the commit. Task 17 and later UI behavior remains out of scope.

## Review fix round 1: indexed file integrity

Root cause — attachment, signature, and saved-PDF reads trusted the batch snapshot path or `pdfPath` and read bytes directly, without resolving the active `files` index record or comparing the indexed SHA-256. Consequently, a valid replacement image/PDF or an unindexed snapshot could be consumed.

RED — focused PDF regression tests returned HTTP 200 for a replaced saved PDF, replaced receipt evidence, and replaced signature instead of the required domain errors.

Fix — `readVerifiedFile` now resolves the indexed path with `safePath`, reads it, and compares the full SHA-256. Rendering resolves attachment IDs through active, correctly owned/type-matched `files` entries, ignores mutable snapshot path/MIME/hash metadata, and determines WebP from verified bytes. Image signatures require an active `default`/`signature` index entry. Saved-PDF routes require exactly one active PDF index record matching the batch owner and `pdfPath`, and return `PDF_NOT_FOUND` for absent, deleted, unindexed, unreadable, or tampered data. Exports stop before file persistence when evidence verification fails.

GREEN — `pnpm --filter @auto-reimbursement/api test test/pdf.test.ts` passed 4/4; `pnpm --filter @auto-reimbursement/api test` passed 157/157; API typecheck and `git diff --check` exited 0. Regressions cover replaced and unindexed attachments, replaced signatures, tampered and unindexed saved PDFs, and no persisted partial export.
