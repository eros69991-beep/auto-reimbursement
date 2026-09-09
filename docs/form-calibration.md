# Reimbursement form calibration

## Font provenance

- Font: Noto Sans SC Regular TTF, obtained from the Google Fonts official repository at `https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf` on 2026-09-10 and retained as `apps/api/assets/fonts/NotoSansSC-Regular.ttf`.
- License: SIL Open Font License 1.1, retained verbatim in `apps/api/assets/fonts/OFL.txt` from `https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt`.
- SHA-256: `A3041811A78C361B1DE50F953C805E0244951C21C5BD412F7232EF0D899AF0DA`.
- PDFKit registration was exercised by the PDF.js extraction test with `useSystemFonts:false`; Chinese labels and `壹佰叁拾元柒角肆分` extracted from the embedded font.

## Geometry and measurement

`apps/api/assets/form-geometry.json` holds the physical millimetre geometry. The renderer converts millimetres once with `72 / 25.4` points per millimetre. It uses a 270 x 165 mm landscape page, 5 mm outer margin, a title at 9 mm, double underlines at 21/22 mm, metadata at 29 mm, and the table at 5,34 mm with 260 mm width. Column widths are 50/98/46/8/58 mm for project, summary, amount, vertical label, and notes/approval.

The 17 mm header, 58 mm body, 12 mm total row, 14 mm uppercase/loan strip, five faint body guides, upper notes/lower approval split, and 146 mm footer baseline were calibrated against the two supplied paper photographs after normalising their four page corners. Both show the same title/underline, column order and relative widths, nine digit headings (`百 十 万 千 百 十 元 角 分`), notes/approval split, total/uppercase strip, and footer order. The private photos and their handwriting were inspected only; neither source nor a derivative is part of the repository.

Perspective, paper curl, and no ruler in either photograph mean 270 x 165 mm remains an explicit working-page assumption. This is a structural calibration, not an assertion of millimetre-perfect physical fidelity.

## Render evidence

The deterministic fixture uses one 耗材 group with 36.33, 17.30, 35.75, and 41.36, a blank date, and a text signer. It produced a one-page 765.354 x 467.717 point PDF. The local bundled Poppler rasterization command was:

```powershell
& 'C:\Users\Admin（无密码）\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe' -r 144 -png tmp/pdfs/form-fixture.pdf tmp/pdfs/form-fixture
```

The resulting PNG was visually inspected at original resolution. Title and double rule, five guides, column ratios, digit headings/grid, notes/approval divider, total digits, uppercase/loan strip, and footer labels were legible and free of clipping or overlap. Poppler emitted non-fatal `nameToUnicode` lookup warnings caused by its bundled path encoding; it still wrote the inspected PNG successfully.
