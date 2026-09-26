# Context Map — 报销系统修复（Task 00 定位结果）

定位时间：2026-09-26。仓库：`.worktrees/mvp-implementation`，分支 `feature/mvp-implementation`，基线提交 `0ac371b`（工作区干净）。无 AGENTS.md。计划原文：`docs/reimbursement-fix/plan.md`。

## 运行与测试命令

- 环境：Git Bash 需先 `export PATH="/c/Users/Admin（无密码）/AppData/Local/Programs/Kimi/resources/resources/runtime:/c/Users/Admin（无密码）/AppData/Roaming/npm:$PATH"`（node 24 / pnpm 11）。
- 启动：`pnpm dev`（`scripts/dev.mjs`，API `apps/api/src/server.ts` 127.0.0.1:3000 + Vite web，/api 代理）。
- 测试：`pnpm test`（三包 vitest：contracts 25 / api 181 / web 28）、`pnpm typecheck`、`pnpm --filter @auto-reimbursement/web build`、`pnpm fixtures && pnpm test:e2e`（Playwright/node runner，9 个）。
- 单跑 API 测试：`pnpm --filter @auto-reimbursement/api test`；单文件：`pnpm --filter @auto-reimbursement/api exec vitest run test/form.test.ts`。
- PDF  rasterize 比对：Poppler `pdftoppm.exe -r 144 -png in.pdf out`（路径见 docs/form-calibration.md）。

## 数据流（生成链路）

上传 `POST /receipts`（routes.ts）→ 队列识别 `queue.ts` → AI `ai/openai-compatible.ts` + `ai/prompt.ts` + `ai/validate.ts`（zod，`category` 为 `z.enum(CATEGORIES)`）→ `decision.ts applyAnalysis`（阈值/强规则冲突 → ready|pending）→ 人工修正 `ReceiptEditor.tsx` → `PATCH /receipts/:id`（receipts.ts）→ `learning.ts recordCorrection`（按 merchant/keyword 精确匹配记规则）→ 建批 `POST /batches`（batches.ts `createBatch` → `layout.ts groupItems/packGroups` 按分类分组分页）→ 预览 `GET /batches/:id/preview.pdf`（render/pdf.ts `renderBatchPdf` 每次现渲染）→ 选项保存 `PATCH /batches/:id/options`（`updateBatchOptions`）→ 定稿 `POST /batches/:id/export`（`exportBatchPdf`，写 `pdfPath` 缓存）→ 下载 `GET /batches/:id/pdf`（`readSavedBatchPdf` 读缓存）。撤销 `POST /batches/:id/cancel`。

关键不变量：`assertDraft`（batches.ts:341）——`pdfPath` 非空即 BATCH_FINALIZED，定稿后改选项/移动分组必须先撤销；`exportBatchPdf` 只在 `pdfPath === null` 时重渲染，因此不存在「改后下载旧缓存」路径（定稿即锁）。

## 五个问题的入口与现状

### P1 模板（Task 04）
- 现状模板：`apps/api/src/render/form.ts` + `apps/api/assets/form-geometry.json`（270×165mm 页，表格 260mm，上一轮已按旧照片像素校准）。
- 新基准：`apps/api/assets/form-reference-hd.png`（4961×2785，比例 1.781 ≈ 计划所述 210×117.9mm 画布）。计划提到的 SVG/PDF 版本用户未提供，只有 PNG。
- 版式差异（初判）：新模板行列比例与旧照片接近但行数区域/金额格位置需重新测量；纸张保持 270×165，模板等比缩放置入。
- 测试：`apps/api/test/form.test.ts`（pdf.js 文本抽取断言）。

### P2 百慕达食材（Task 02）
- 枚举：`packages/contracts/src/index.ts` CATEGORIES 第 2 项即 `百慕达食材`（独立于 `食材`）。
- 后端链路未见合并点：validate 用完整枚举；decision.matchesRule 是 `normalizeFeature` 后**精确相等**；learning.featureFor 也精确。怀疑点：① AI 模型自身把百慕达小票归到 `食材`（识别质量，非代码合并）；② 既有学习规则 merchant→食材 命中后造成 rule_conflict 显示异常；③ 前端展示层。Task 02 需用最小样本实际追踪复现，再定点修。
- 相关文件：`apps/api/src/decision.ts`、`apps/api/src/learning.ts`、`apps/api/src/receipts.ts`（PATCH 校验）、`apps/web/src/components/ReceiptEditor.tsx`（分类选择器，枚举渲染正常）、`apps/api/test/decision.test.ts`、`apps/api/test/learning.test.ts`。

### P3 备注编辑（Task 03）
- 现状：备注是「命名模板」——`NotesEditor.tsx`（设置页）CRUD `/api/notes`；`PreviewPage.tsx` 每页 sheet 只有一个 `<select>` 选既有模板（`sheet.noteId`），**没有**直接的多行编辑窗口。
- API：`routes.ts` notes CRUD；`batch.notes[]` + `sheet.noteId`；`PATCH /batches/:id/options` 的 `noteBySheet`。
- 纸上渲染：`form.ts drawNote`（右块上格，NOTE_OVERFLOW 抛错，无续页——Task 04 需注意计划要求续页）。
- 测试：`apps/api/test/batches.test.ts`、e2e `release-contract.spec.ts`（noteBySheet 流程）。

### P4 报销人/部门持久化（Task 01）
- 默认值：`SettingsPage.tsx` → `PUT /settings`（settings.ts `resolveOptions` 建批时取快照）。
- 批次级：`PreviewPage.tsx` 本地编辑 options → 「保存预览设置」→ `PATCH /batches/:id/options` → `updateBatchOptions`（batches.ts:140）。
- 风险点（待复现验证）：① 编辑后未点保存直接下载 → 下载的是旧快照（交互问题，非丢字段）；② 保存与 preview.pdf 的 `?revision` 刷新竞态；③ 「不能稳定上传报销单」可能指定稿后无法改（BATCH_FINALIZED 设计如此）或真实上传失败，需实际复现。
- 测试：`apps/api/test/batches.test.ts`、`apps/web/src/pages/PreviewPage.test.tsx`、e2e release-contract。

### P5 同屏对账（Task 05/06）
- 现状：`PreviewPage.tsx` 只有 `PdfPreview.tsx`（pdf.js 按宽渲染整份 PDF）+ 下载链接；凭证图片在 `PoolPage`/`ReceiptEditor` 侧查看，预览页无附件列表、无关联查看。
- 附件数据：`batch.items[].original/refundImages`（ImageRef，path 经 `GET /files/:id` 或 originals 路由读取——Task 05 需确认图片 URL 入口）；关联：`FormGroup.receiptIds` ↔ `Snapshot.receiptId`，顺序 = `uploadOrder`。
- 样式：`apps/web/src/styles.css`（已有移动端 overflow 修复）。

## 决策记录

- 参考模板只有 PNG（无 SVG），Task 04 以 PNG 重新像素测量几何，不宣称物理尺寸校准（沿用 270×165 纸型等比放置）。
- 不为备注新建平行数据层：沿用 Note 实体 + noteId 关联，UI 上把「编辑这张单的备注」做成直接编辑窗口（Task 03 决定是建专用 Note 还是扩展 API）。
