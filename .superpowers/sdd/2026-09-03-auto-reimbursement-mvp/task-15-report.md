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
