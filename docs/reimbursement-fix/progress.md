# Progress — 报销系统修复

## Task 00 定位与索引 — ✅ 完成（2026-09-26）

- 产出：`docs/reimbursement-fix/context-map.md`（真实路径、数据流、测试命令、五问题入口）；参考图已存 `apps/api/assets/form-reference-hd.png`；计划存 `docs/reimbursement-fix/plan.md`。
- 未改业务代码。基线：git 干净 @ `0ac371b`；上一轮全量验证（234 单测 + e2e 9/9 + typecheck + build）通过。
- 关键事实：CATEGORIES 枚举本就含独立「百慕达食材」；备注目前是「命名模板 + 下拉选择」，无直接编辑窗口；定稿后编辑被 BATCH_FINALIZED 阻止（设计行为，配合撤销使用）；export 有 pdfPath 缓存但定稿即锁，无「改后下载旧缓存」路径。
- 复现记录：P2/P4 的实际症状需在 Task 01/02 用样本跑一遍确认（计划要求先复现再修）。

## Task 01 报销人/部门保存链路 — ✅ 完成（2026-09-26）

- 复现（`tmp/task01-repro.mts`，FixtureRuntime 全链路）：13 项检查中 12 项通过 —— 建批写入、PATCH 修改、重读、预览含新值、重启（模拟刷新）后仍在、导出下载同一快照、定稿后 409 锁定均正常。**唯一 FAIL：连续两次 GET preview.pdf 字节不等**。
- 根因（`tmp/task01-diff.mts` dump 确认）：差异仅在 PDF trailer 的 `/ID`（8 处 diff 全是它），文本内容完全一致。PDFKit 构造时用 `new Date()` 作 CreationDate 并据其 MD5 生成文档 ID，导致每次生成字节不同。
- 修复（最小）：`apps/api/src/render/form.ts` `createFormDocument()` 增加 `info: { CreationDate: new Date(0) }`，文档 ID 恒定 → 同一数据连续生成字节一致（幂等）。
- 固化：`apps/api/test/persistence.test.ts` 新增全链路测试（建批→PATCH→重读→预览两次字节一致且含新值→关闭重开同一 SQLite→导出下载含同一快照→定稿后 PATCH 返回 409 BATCH_FINALIZED）。
- 验证：复现脚本 13/13 PASS；`pnpm --filter @auto-reimbursement/api test` 182/182 通过。

## Task 02 百慕达食材独立分类 — ✅ 完成（2026-09-26）

- 逐层排查（读码确认，无子串/兜底归并点）：
  - AI 解析 `ai/validate.ts`：`z.enum(CATEGORIES)` 精确枚举，非法值报 INVALID_RESPONSE，不会静默映射成「食材」。
  - 决策 `decision.ts`：学习规则只用于确认/冲突（rule_conflict → pending），从不改写 `analysis.category`；规则匹配为 normalizeFeature 后**精确相等**（NFKC+去空格，不裁剪「百慕达食材」）。
  - 队列 `queue.ts`/`applyAnalysis`：仅 `recognizing` 状态可落识别结果；人工编辑后状态变 pending/ready，迟到的识别结果抛 INVALID_RECEIPT_STATE 且 `recordFailure` 早退，**人工分类不被覆盖**。
  - 重识别 `POST /receipts/:id/retry`：仅允许 api_failed 的 pending 凭证，人工凭证 409 RETRY_NOT_ALLOWED。
  - 建批 `batches.ts`/表单 `form.ts`：按 category 精确分组，无合并。
- 追踪脚本 `tmp/task02-trace.mts`（FixtureRuntime 全链路，计划样本：百慕达食材 100.00 + 食材 50.00）：22/22 PASS —— 识别精确落库、人工改→确认→重启仍在、retry 被拒、建批两组独立总额 15000 分、预览/导出 PDF 两行两分类、表单页合计拆位「合计15000」。
- 结论：**当前代码不存在错误转换点**（首次转换点排查无果=各层均保持分类）；生产端曾见的归类问题属 AI 建议不准 → 人工纠正 → 学习规则（3 次确认成强规则，冲突时转人工 pending）的设计路径，符合计划「AI 只能提供建议」。
- 固化 `apps/api/test/category-independence.test.ts`（4 测试）：百慕达→百慕达/食材→食材精确落库；人工改后重启仍在 + retry 409 + 迟到识别不覆盖；两类同批 100.00+50.00=150.00 不合并且 PDF 验证；强学习规则冲突 → pending 不改写类别、精确匹配优先。
- 验证：`pnpm --filter @auto-reimbursement/api test` 186/186 通过。未改业务代码（本 Task 纯测试固化）。

## Task 03 备注编辑窗口 — ✅ 完成（2026-09-26）

- 复现确认：PreviewPage 每页 sheet 仅有模板 `<select>`（batch.notes 快照），无多行编辑入口；且 `updateBatchOptions` 校验 noteId ∈ batch.notes 快照，全局新建模板无法挂到已建批次。
- 设计（不建平行数据层）：Batch.notes 本就是**每批次快照**，批次内编辑天然与全局模板、A/B 批次隔离。
- 后端（最小新增）：
  - `batches.ts`：`createBatchNote` / `updateBatchNote`（只改批次快照，assertDraft 定稿锁定，复用 `validateNote`：name 1–100、content ≤2000）。
  - `routes.ts`：`POST /api/batches/:id/notes`（201）、`PUT /api/batches/:id/notes/:noteId`；`batchHttpError` 增加 NOTE_NOT_FOUND→404、INVALID_NOTE→400。
  - `settings.ts`：`validateNote` 导出复用。
- 前端：
  - `components/NoteEditor.tsx`：多行弹窗（role=dialog），打开读已保存值；保存/取消/清空；字数提示（≤2000，沿用既有限制）；保存空字符串=清空本页备注；失败保留输入并提示；按钮 sticky 底部（手机键盘可达）；纯文本渲染无 HTML 执行。
  - `PreviewPage.tsx`：每页 sheet 增加「编辑备注」按钮；模板 select 标注「选模板会替换当前备注」；保存逻辑——空串→noteId 置 null；有独立备注→PUT 就地更新；无备注或被他页共用→POST 新建（自动命名「第 N 页手写备注」）再关联；成功后 revision+1 刷新预览。
  - `api.ts`：`createBatchNote` / `updateBatchNote`；`styles.css`：`.modal-backdrop/.modal-card/.modal-actions`（88dvh 可滚动，移动端适配）。
- 测试：`apps/api/test/batch-notes.test.ts`（4：多行中文标点换行保存+刷新恢复、就地更新+清空、A/B 批次与全局模板隔离、非法输入 400/404 + 定稿 409）；`apps/web/src/pages/PreviewPage.test.tsx`（4：新建并关联、就地更新、取消不保存+清空解除关联、失败保留输入提示）。
- 验证：全量 `pnpm test` 245/245（contracts 25 + web 30 + api 190）、`pnpm typecheck` 通过。

## Task 04 接入清晰版模板 — ✅ 完成（2026-09-26）

- 高清参考图 `apps/api/assets/form-reference-hd.png`（4961×2785 干净数字版空白单）像素级测量（`tmp/measure-hd*.py` 可重跑），全部几何重写进 `apps/api/assets/form-geometry.json`（比例 0.0570114 mm/px，页 270×165、表 x=5 y=34 宽 260 不变）。
- `form.ts` 结构性修正（对照参考图）：
  - headerSplit 细分线延伸为 amountX→notesX（含竖标签列）；竖排「备注」改为从 headerBottom 起（body 区垂直居中，step 6mm）；「领导审批」step 7.4mm。
  - 大写条：原借款区起点改为 项目+摘要列右缘（142.34mm 表相对）；删除原借款/应退补款区下划线（参考图无）。
  - 页数下划线偏移改由 geometry `metadata.underlineOffset`（16.6pt）驱动。
  - 长部门/长报销人：`drawFittedText` 10→7pt 逐级缩字号，仍超宽则 7pt 限高换行，再超才抛 FORM_TEXT_OVERFLOW（90 字部门仍抛，原测试保留）。
  - 长备注不再 NOTE_OVERFLOW：`paginateNote` 二分求首页可容纳前缀 +「（接续页）」，余文分页画「备注续页」（同纸型，标题+全文）；页数计数 = 1 + 续页数 + 附件页数。
- `layout.ts` `defaultMetrics()` 硬编码 91.15/55.14 → 90.8/55.22，与 JSON 对齐。
- 渲染验证：`tmp/render-sample.mts` 匿名样本（能耗费 277.20 + 耗材两笔 248.43 = 525.63）→ pdftoppm 144dpi → 与参考图并排目检（`tmp/compare-hd.png`）：标题双线、列比、九宫金额格、单位格、原借款/应退补款、竖排标签、页数下划线全部对位。
- 测试：`form.test.ts` 新增 2（20 字长部门缩字号渲染含原文；约 340 字长备注 → 2 页 PDF、首页含「（接续页）」与「单据及附件共3页」、续页含「备注续页」标题与备注结尾）。
- 验证：全量 `pnpm test` 247/247（contracts 25 + web 30 + api 192）、`pnpm typecheck`、web build、`pnpm fixtures && pnpm test:e2e` 9/9 全部通过。

## Task 05 电脑/平板双栏对账 — ✅ 完成（2026-09-27）

- 新组件 `apps/web/src/components/ReconcileWorkspace.tsx`：左侧报销单（可点击报销行 + 原 PdfPreview），右侧凭证附件查看器。关联基于 receiptId（不依赖数组下标）：点击行定位该行第一张凭证；手动切换附件时反查高亮所属行；行内多凭证按 uploadOrder 排序逐张看。
- 右栏：标题「第 i/N 张 · 分类 · 商家 · 实付金额」；上一张/下一张（边界禁用）、放大/缩小（×1.25 步进，0.5–4×）/恢复适宽；图片完整不裁切、仅右栏内滚动；加载失败给重试且不丢左侧；空批次有空状态。
- PreviewPage 改用 ReconcileWorkspace（PDF 下载入口保留）；样式 `.reconcile*`：≥900px 左右双栏（55/45）、高 `calc(100dvh - 11rem)`、各自 `overflow-y: auto` 独立滚动。
- 测试 `ReconcileWorkspace.test.tsx`（6）：行列表+首附件标题、点击行跳转+高亮、上/下一张与高亮跟随、缩放/恢复适宽、空状态、加载失败重试。
- 真实浏览器验证（`tmp/reconcile-shots.mts`，夹具后端+ vite）：1440×900 与 1024×768 截图 `tmp/reconcile-*.png`——双栏并排（坐标断言 sideLeft > formLeft+formWidth）、行高亮、右侧滚长图时左侧单据仍在。
- 验证：全量 `pnpm test` 253/253（25+36+192）、typecheck、web build、e2e 9/9 通过。

## Task 06 手机上下分区对账 — ✅ 完成（2026-09-27）

- `PdfPreview` 每页 canvas 加 `data-page-number`；`ReconcileWorkspace` 切换附件时按所属 sheet 滚动左侧报销单到对应页（`scrollIntoView({block:'nearest'})`，可选调用防御 jsdom）。
- 样式 `<900px` 上下分区：`.reconcile` 高 `calc(100dvh - 11rem)`、上 40% 单据 / 下 60% 附件、各自内部滚动，行列表 `position: sticky` 吸附顶部（选中行类别/合计/凭证数始终可读）；窄屏横屏（高 <500px）收紧为 `calc(100dvh - 13.5rem)`，附件工具栏不被挤出视口。
- 未做临时全屏看图（计划列为可选）；默认即为同屏对账。
- 测试：`ReconcileWorkspace.test.tsx` 第 7 条——两页批次点第二页行触发 scrollIntoView、按钮标注「第 2 页 · 」。
- 真实浏览器验证（`tmp/reconcile-mobile.mts`）：390×844、430×932、844×390 横屏三视口截图 `tmp/reconcile-*.png`——stacked/formVisibleAfterScroll/rowsSticky 全 true（滚动附件中部时上方单据与行列表仍在）。
- 工具限制说明：无真实 iPhone Safari，用 Chromium 移动视口（isMobile+hasTouch）验证；WebKit 真机建议交付后由用户手机复查。
- 验证：全量 `pnpm test` 254/254（25+37+192）、typecheck、web build、e2e 9/9 通过。

## Task 07 集中回归与交付 — ✅ 完成（2026-09-27）

### 回归中发现并修复的真实 bug（计划外但属 Task 01 范围）

- 症状（`tmp/regression-main.mts` 走查暴露）：先改部门/签名人（未保存）再保存备注，输入被服务器旧快照回写清空。
- 根因：`saveSheetNote` 的就地更新/新建路径用 `updateBatchNote`/`createBatchNote` 响应里的服务器旧 `options` 覆盖本地未保存输入。
- 修复：就地更新路径合并 `{ ...updated, options: batch.options }`；新建路径用本地 `batch.options` 调 saveBatchOptions（顺带一次保存到位）。固化测试：`PreviewPage.test.tsx` 新增 2 条（create/in-place 两路径均保留未保存输入）。

### 集中回归证据（全部通过）

- `tmp/regression-main.mts`（浏览器全链路，1440×900 Chrome）：上传 → 识别 → 待处理人工改「百慕达食材」（100.00）→ 建批（totalFen 22000）→ 填部门「武汉测试店」/签名人「测试报销人甲」→ 多行备注保存 → **刷新后字段全部恢复** → 同屏对账点击百慕达食材行右侧定位 → 生成 PDF（含部门/签名人/两类分类/备注两行/合计拆位 22000）→ 定稿锁定 → 撤销 → 重建改部门「新部门乙」→ **新 PDF 含新部门、不含旧部门、字节不同**（无旧缓存）。
- `tmp/regression-edge.mts`（API 级边界批次）：6 分类 → 2 张报销页；分张合计之和 = 批次总计 = 凭证净额之和（不漏不重）；1926 字长备注 → 2 页备注续页（共 10 页 = 2 表单 + 2 续页 + 6 附件），第 1 页含「（接续页）」且页数计数含续页；续页保留备注全文结尾；每张报销页合计拆位正确；**重启后旧批次、sheet 与长备注完整可打开**。
- 既有证据：Task 04 模板对照 `tmp/compare-hd.png`；Task 05 `tmp/reconcile-1440x900*.png`、`tmp/reconcile-1024x768*.png`；Task 06 `tmp/reconcile-390x844*.png`、`tmp/reconcile-430x932*.png`、`tmp/reconcile-844x390-landscape*.png`；主链路对账截图 `tmp/regression-main-reconcile.png`；PDF 产物 `tmp/regression-main-v1/v2.pdf`、`tmp/regression-edge.pdf`。

### 五个问题逐项结论

1. 报销人/部门/备注保存丢失 → Task 01（PDF 幂等）+ Task 03（备注编辑）+ Task 07（options 覆盖修复）：保存、刷新、预览、导出全链路一致，有测试与走查证据。
2. 百慕达食材被并入食材 → Task 02：全链路无错误转换点，4 条固化测试；主回归再走一遍人工改分类 → PDF 两类独立。
3. 备注无法编辑 → Task 03：编辑窗口 + 批次内快照隔离；长备注 → Task 04 续页。
4. 报销单与参考模板不符/显示不全 → Task 04：高清模板几何接入，像素级对照；备注续页 + 长部门缩字号保证完整显示。
5. 无法同屏对账 → Task 05/06：桌面双栏（1440×900、1024×768 验证）、手机上下分区（390×844、430×932、844×390 横屏验证），独立滚动、行↔凭证 receiptId 关联。

### 剩余限制与交接

- 未测环境：真实 iPhone Safari/WebKit（工具限制，用 Chromium 移动视口代替）；建议交付后手机复查一次。
- 无数据库迁移：Batch.notes 快照、geometry JSON 均为新增字段/资源，旧批次读取走既有默认值路径（重启回归已验证旧记录可打开）。
- 回退方式：全部改动在 `feature/mvp-implementation` 工作区未提交修改内，`git checkout -- .` 可回到基线 `0ac371b`；证据与脚本在 `tmp/`（不进版本库）。
- 最终验证：`pnpm test` 256/256（contracts 25 + web 39 + api 192）、`pnpm typecheck` 3 包、web build、`pnpm test:e2e` 9/9、`git diff --check` 干净。
- 按用户要求：**未提交、未推送、未发布线上**，等用户验收后明示再提交。
