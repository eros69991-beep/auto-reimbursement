# 审查修复进度记录

依据 `docs/review-fix/plan.md`，对照 `docs/review-fix/review-report.md`。

## T01 — P-01 访问码鉴权 + helmet + 限流（完成，待用户配置后生效）

后端：
- `config.ts`：新增 `ACCESS_CODE_SHA256`（64 位 hex，非法值启动即抛 `INVALID_ACCESS_CODE_SHA256`）；未配置 = 本机开发模式放行。
- `auth.ts`（新增）：`requireAccess` 中间件，`Authorization: Bearer <访问码>`，SHA-256 + `timingSafeEqual` 比对；`/health` 在 `/api` 之外保持开放。
- `app.ts`：挂载 `helmet`（CORP cross-origin 供前端 fetch 图片）、`x-powered-by` 关闭；`/api` 全局限流 600 次/5 分钟，上传/备份/清理严格限流 30 次/10 分钟；鉴权中间件在路由之前。
- `server.ts`：未配置访问码时启动打印安全警告。
- `test/auth.test.ts`（新增 8 例）：无码 401、错码 401、正确码 200、无 Origin 的 mutation 也 401、/health 开放、未配置放行、非法配置拒绝启动、安全响应头。

前端：
- `api.ts`：访问码存 localStorage；`requestJson`/`deleteReceipt` 自动带 `Authorization`；401 时广播 `api:unauthorized`；新增 `fetchBlobUrl`/`openAuthed`（图片、PDF 不再依赖 `<img src>`/裸链接带鉴权）。
- `AccessGate.tsx`（新增）：401 后全屏访问码页，验证通过刷新页面。
- `AuthedImage.tsx`（新增）：`useAuthedUrl` hook + 组件，替换 ReceiptCard、ReconcileWorkspace 的 `<img src>`；链接类（历史页 PDF/原件、待处理页历史凭证、上传页重复凭证、预览页下载 PDF）改为 `<a href>` + 点击拦截走 `openAuthed`（保留 link 语义）。
- `.env.example`：补充 `ACCESS_CODE_SHA256` 配置与生成方法。

**用户待办（部署时）**：Railway 设置 `ACCESS_CODE_SHA256`（访问码的 SHA-256），鉴权即生效；生效后建议更换一次 Railway 域名。

## T09 — P-08 pdf.js 改 legacy 构建（随 T01 一并完成）

- `PdfPreview.tsx`：改用 `pdfjs-dist/legacy/build/pdf.mjs` + legacy worker（自带 `Map.prototype.getOrInsertComputed` polyfill，覆盖 Chrome<145、iOS Safari<26.2、微信/国产内核）；`getDocument` 带 `httpHeaders`（鉴权）；catch 不再吞异常（console.error）；取消/出错时 `loadingTask.destroy()` 释放 worker（顺带修了 P-27 的资源泄漏部分）。

## 验证

- `pnpm typecheck`：3 包全绿（含 fixture-runtime 补 `corsOrigins`/`accessCodeSha256`，顺带修了 P-30 的 e2e TS2741）。
- `pnpm test`：contracts 25 + api 200（含新增 auth 8）+ web 39 全部通过。
- `pnpm --filter @auto-reimbursement/web build`：通过，legacy worker 正常分包懒加载。

## T03 — P-03 退款 > 实付白屏（完成，commit 4c9a530）

- contracts：新增 `netFenOrNull`（脏数据返回 null 而不是算出负数）。
- `receipts.ts`：updateReceipt/confirmReceipt 在 退款 > 实付 时抛 `REFUND_EXCEEDS_PAID`；`routes.ts` 映射 409「退款金额不能大于实付金额，请先调整退款」。
- `refunds.ts`：isEligible 防御式判断 + console.warn；ReceiptCard/PoolPage 改用 `netFenOrNull`；ReceiptEditor 提交前校验。
- `ErrorBoundary.tsx`（新增）：包在 App content 外，极端情况不再白屏。
- `scripts/audit-refunds.mjs`（新增）：存量脏数据排查脚本。
- `test/refund-invariant.test.ts`（新增 4 例）。

## T04 — P-04 长商户名整批 500（完成，commit e399ab0）

- `form.ts`：新增 `drawSummaryText`（10→7pt 逐级缩字号，仍超宽则截断加「…」，绝不抛错）；摘要栏改用它。
- `routes.ts`：batchHttpError 映射 `FORM_TEXT_OVERFLOW`/`FORM_AMOUNT_OVERFLOW` → 400 + console.error（不再 500）。
- `test/form-long-merchant.test.ts`（新增 2 例）：27 字缩字号全显示、50 字截断加省略号。

## T05 — P-02 单类超 10 张无法生成 + P-07 行线压字（完成）

汇总版式：每个分类在表体固定占一行（与纸面 5 行对齐），摘要写「共 N 张：商户A、商户B 等」（单张直接写商户名，无商户名写「共 N 张，明细见附件」），金额填分类合计。10 张上限自然消失，行线不再压字；逐张明细仍保留在附件页。

- `layout.ts`：`groupHeight` 改为固定一行（有 rowHeight 用 rowHeight，否则 lineHeight + groupPadding）。
- `form.ts`：`drawGroups` 重写——每 group 一行、文字垂直居中、摘要走 `summarizeGroup` + `drawSummaryText`、金额画 `group.totalFen`；删除逐张行高溢出检查和每组分隔线重画（表体 5 行线已在 drawFrame 统一画好）。
- 测试：`layout.test.ts` 第 1 例改期望 1 张表（2 组 × 20 = 40 ≤ bodyHeight 40）、第 2 例改期望固定行高 20；`form.test.ts` overflow 构造改为 6 个分类溢出 5 行表体，新增「共4张，明细见附件」摘要断言。

## 验证（T03–T05）

- `pnpm typecheck`：3 包全绿。
- `pnpm test`：contracts 25 + api 206 + web 39 全部通过。
- `pnpm --filter @auto-reimbursement/web build`：通过。
- `pnpm test:e2e`：9/9 通过。
