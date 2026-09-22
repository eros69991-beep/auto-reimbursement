# Reimbursement form calibration

## Font provenance

- Font: Noto Sans SC Regular TTF, obtained from the Google Fonts official repository at `https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf` on 2026-09-10 and retained as `apps/api/assets/fonts/NotoSansSC-Regular.ttf`.
- License: SIL Open Font License 1.1, retained verbatim in `apps/api/assets/fonts/OFL.txt` from `https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt`.
- SHA-256: `A3041811A78C361B1DE50F953C805E0244951C21C5BD412F7232EF0D899AF0DA`.
- PDFKit registration was exercised by the PDF.js extraction test with `useSystemFonts:false`; Chinese labels and `壹佰叁拾元柒角肆分` extracted from the embedded font.

## Geometry and measurement

`apps/api/assets/form-geometry.json` holds the physical millimetre geometry. The renderer converts millimetres once with `72 / 25.4` points per millimetre. It uses a 270 x 165 mm landscape page, 5 mm outer margin, a title at 9 mm, double underlines at 21/22 mm, metadata at 29 mm, and the table at 5,34 mm with 260 mm width. Column widths are 50/98/46/8/58 mm for project, summary, amount, vertical label, and notes/approval.

The 17 mm header, 58 mm body, 12 mm total row, 14 mm uppercase/loan strip, five faint body guides, upper notes/lower approval split, and 146 mm footer baseline are renderer working values selected from a visual comparison with the two supplied paper photographs. The comparison checked title/underline, column order and relative widths, nine digit headings (`百 十 万 千 百 十 元 角 分`), notes/approval split, total/uppercase strip, and footer order. It was not a measured physical calibration: the photos have perspective, curl, and no reliable scale. The private photos and their handwriting were inspected only; neither source nor a derivative is part of the repository.

The 270 x 165 mm page remains an explicit working-page assumption. The review establishes structural resemblance only; it does not assert millimetre-perfect physical fidelity.

## Render evidence

The deterministic fixture uses one 耗材 group with 36.33, 17.30, 35.75, and 41.36, a blank date, and a text signer. It produced a one-page 765.354 x 467.717 point PDF. The local bundled Poppler rasterization command was:

```powershell
& 'C:\Users\Admin（无密码）\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe' -r 144 -png tmp/pdfs/form-fixture.pdf tmp/pdfs/form-fixture
```

The resulting PNG was visually inspected at original resolution. Title and double rule, five guides, column ratios, digit headings/grid, notes/approval divider, total digits, uppercase/loan strip, and footer labels were legible and free of clipping or overlap. Poppler emitted non-fatal `nameToUnicode` lookup warnings caused by its bundled path encoding; it still wrote the inspected PNG successfully.

## 2026-09-22 recalibration against the supplied paper-form photo

A supplied photo of the blank paper form (`费用报销单`) drove these renderer changes: the title now uses letter spacing with double rules fitted to the measured title width; the metadata row prints the date as `YYYY 年 M 月 D 日` (blank mode prints bare `年 月 日` labels); the summary column carries per-receipt merchant text (falling back to the category) instead of decimal amount lists; every receipt amount occupies its own row in the nine-digit grid; the total row label spans the project and summary columns; and the uppercase strip renders the printed unit grid `佰 拾 万 仟 佰 拾 元 角 分` with one digit per cell, followed by `原借款：＿元` and `应退（补）款：＿元`. Snapshot rows now retain the merchant name; batches created before this change fall back to the category as summary text. One receipt per row raises the per-sheet line requirement: a category group must fit the 58 mm body (about eleven 14 pt lines) or batch creation reports CATEGORY_TOO_LARGE, unchanged from the previous overflow contract. A four-receipt sample was rendered and rasterized with the same Poppler command and visually compared against the photo; column order, digit grids, and footer matched. This remains structural resemblance, not millimetre-perfect physical fidelity.

## 2026-09-23 pixel-measured 1:1 replication

A second pass measured the supplied blank-form photo (634 x 365 px) directly. The table rules were located by dark-pixel projection: horizontal rules at photo y = 92/129/153/177/201/225/250/274/304 and vertical rules at x = 29.5/142/342/448/465/600, with nine amount digit columns of about 11.8 px each across x 342..448. Using 570.5 px = 260 mm (0.4557 mm/px), all geometry values in `form-geometry.json` are now measured rather than estimated: columns 51.27/91.15/48.31/7.75/61.52 mm; header 16.86 mm with an amount-zone sub-split at 7.75 mm carrying the printed unit labels `百 十 万 千 百 十 元 角 分`; body 55.14 mm as exactly five printed rows of 11.03 mm; total row 10.94 mm; uppercase strip 13.67 mm; the notes/leader-approval column splits at 74.56 mm absolute; the footer baseline sits about 3.7 mm below the table (y = 134.3 mm).

Structural corrections from the same measurement: body and total-row rules stop at the note-label column (x = 448 px) and never cross the notes/approval block; the strip row has no internal verticals except the continuation of the amount boundary and one divider at x = 456 px separating `原借款：＿元` from `应退(补)款：＿元`; the strip's printed unit labels are `佰 拾 万 仟 佰 拾 元 角 分` in one open cell with a two-line `金额/(大写)` label; header labels are justified across their columns at (i+1)/(n+1) positions; `合 计` sits at the 1/3 and 2/3 positions of the merged project+summary region; the title is set at 28 pt with characters at measured centres (90/110/130/150/170 mm absolute) over a decorative double rule spanning 66.3..193.9 mm at y = 17.1/19.0 mm; footer labels `会计主管 复核 出纳 报销人` print without colons at 12.1/84.9/146/204.8 mm. The photo showed no rotation (vertical rules constant within 1 px top to bottom).

Layout behaviour change: `LayoutMetrics` gains an optional `rowHeight`; when set, `groupHeight` rounds each group up to whole printed rows so filled forms keep the paper grid. With five rows per sheet this reduces single-line group capacity from seven to five per sheet, matching the paper form; the e2e packing expectation was updated accordingly. A four-receipt sample was re-rendered, rasterized, and overlaid on the photo at matched scale; rules, labels, and footer aligned within about 1 px of the photo.
