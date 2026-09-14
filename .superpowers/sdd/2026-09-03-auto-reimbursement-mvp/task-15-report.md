# Task 15 report - measured Chinese reimbursement forms

## Artifact operation

Before the first authoring operation, the PDF workflow marker completed successfully exactly once:

```powershell
node container_tools/mark_artifact_operation_started.mjs --operation-kind create --expected-output-count 1 --output-format pdf
```

## Evidence

- RED: `pnpm --filter @auto-reimbursement/api test test/form.test.ts` failed because `src/render/form.ts` did not exist.
- GREEN: the extraction fixture embeds Noto Sans SC and PDF.js finds all mandated Chinese form labels and `壹佰叁拾元柒角肆分` without system fonts.
- Render: `tmp/pdfs/form-fixture.pdf` rasterized to `tmp/pdfs/form-fixture-1.png` at 144 DPI and was visually inspected after the final geometry adjustment.
- Calibration: both private paper reference photos were individually inspected for normalized printed structure only; no private asset or handwriting derivative was copied or committed.

## Scope and concern

Task 15 renders a single form page per `drawForm` call. Attachment-page rendering, preview metadata, safe signature-file reads, and export routes remain intentionally for Task 16 and later work. The page size is a documented measured assumption because the references are perspective photographs without a physical ruler.

## Review round 1 fixes

- The uppercase total field is now measured before text drawing and raises `FORM_TEXT_OVERFLOW` when it cannot fit. A maximum-sheet-total regression test forces that field to exceed its measured width and verifies the error.
- Batch creation, layout validation, and manual moves now all obtain `LayoutMetrics` from a registered Noto Sans SC PDF document. The document has `autoFirstPage:false`, receives no page, and is destroyed immediately after the callback, so metric-only operations do not emit a form artifact. A 55-amount category regression demonstrates that an embedded-font-fitting category can move out and back successfully.
- Title/table/digit-grid/guide rules are all 0.5 pt black; printed labels remain muted blue. A final 144 DPI fixture raster was inspected after this change and showed legible black rules with no clipping or overlap.
