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

## T06 — P-06 大写金额栏填阿拉伯数字（完成）

- `uppercase.ts`：新增 `toUppercaseCells()`，把九格阿拉伯数字逐格映射为「零壹贰叁肆伍陆柒捌玖」，首位之前的空位保持留空。
- `form.ts`：`drawUppercase` 的大写栏改走 `toUppercaseCells`，按财务惯例逐格填中文大写数字（如 130.74 元 → 佰拾元角分 格填「壹叁零柒肆」）。
- 测试：`uppercase.test.ts` 新增 3 例映射用例；`form.test.ts` 用 pdf.js 抽取文本断言大写栏含「壹叁零柒肆」。

## T02 — P-17 结构化日志 + P-20 统一错误表（完成）

P-17 日志：
- 新增 `logger.ts`：pino JSON 行输出，`Authorization`/`set-cookie` 脱敏，`LOG_LEVEL` 可调，测试环境默认静默。
- `app.ts`：挂载 `pino-http` 记录每个请求；500 兜底处理输出结构化错误日志（请求 ID、方法、路径、stack）。
- `server.ts`：启动/安全警告改用 logger；`routes.ts` 版式溢出改用 `logger.error`。

P-20 统一错误表：
- 新增 `errors.ts`：`HttpError` 移入此处；`ERROR_TABLE`（code → HTTP 状态 + 中文文案）+ `toHttpError()` 统一映射；`INVALID_*` 约定一律 400；`MISSING_ATTACHMENT:`/`CLEANUP_FAILED:` 前缀动态文案；路由上下文特需文案用 overrides（批次内备注、批次上下文 ORIGINAL_CLEANED）。
- `routes.ts`：batchHttpError/correctionHttpError/settingsHttpError/maintenanceHttpError 四个分散映射全部改为委托 `toHttpError`（原 5 处映射收敛为 1 张表 + overrides）。
- `app.ts`：未知 `/api/*` 返回 JSON 404 `ROUTE_NOT_FOUND`（原 HTML 404）；JSON 语法错误保留路径特化 code，其余统一 400 `INVALID_JSON`（原 500）；上传多带文本字段返回 400 `INVALID_UPLOAD`（原误导性 413，对应测试同步更新）。
- 前端 `api.ts`：`fetch` 网络层失败（TypeError 'Failed to fetch'）统一翻译为「无法连接服务器，请检查网络后重试」。
- 新增 `test/errors.test.ts` 5 例：JSON 404、两处 INVALID_JSON、路径特化 code 保留、INVALID_UPLOAD。

## T07 — P-05 未保存修改被吞 + 定稿确认（完成）

- `PreviewPage.tsx`：
  - 新增 `saved` 快照（options + noteBySheet），加载/保存/导出/备注持久化后同步推进；`dirty` 由本地与快照 diff 得出。
  - 「生成 PDF」：dirty 时先 `saveBatchOptions`（顺序断言保证先保存后导出），再弹确认框「生成后将锁定：部门 X、报销人 Y、日期 Z」，取消则不导出。
  - `move()`：合并服务器返回的 sheets 与本地未保存的 options、noteId 选择，不再回写旧值。
  - 保存成功显示「已保存」，编辑后显示「有未保存的修改（生成 PDF 前会自动保存）」。
  - dirty 时 `beforeunload` 拦截关闭/刷新，`hashchange` 拦截站内离开（取消则跳回预览）。
- `e2e/workflow.spec.ts`：自动接受定稿确认框。
- `PreviewPage.test.tsx` 新增 4 例：dirty 提示与已保存反馈、未保存直接生成先保存再导出且弹确认、取消确认不导出、move 保留未保存输入。

## T08 — P-10 确认失败凭证“失踪”（完成）

- 后端 `receipts.ts`：`confirmReceipt` 接受可选 patch（paidFen/category），修改与确认在同一个事务完成；校验顺序：格式 → 完整性 → 退款不变量 → 疑似重复。
- `routes.ts`：`POST /receipts/:id/confirm` 解析可选 body（空 body = 只确认），新增 `confirmPatchFromRequest`。
- 前端 `api.ts`：`confirmReceipt(id, patch?)` 单次原子请求；`ReceiptEditor` 删掉「先 PATCH 再 confirm」两步流程与 savedReceipt 状态，失败时凭证保持原状态、输入保留、可直接重试。
- `PendingPage`：显示所有 pending（不再过滤空 reasons），空 reasons 标记为「修改待确认」。
- `scripts/audit-pending.mjs`（新增）：排查存量「pending 且无原因」的遗留凭证。
- 测试：新增 `test/confirm-atomic.test.ts` 4 例（原子确认、无 body 确认、非法 patch 不动状态、违反退款不变量不动状态）；`PendingPage.test.tsx` 3 例改写为原子流程。

## T10 — P-16 PDF 体积与预览缓存（完成）

- `render/pdf.ts`：附件嵌入 PDF 前用 sharp 按 EXIF 自动旋转、缩到长边 1600px、JPEG q80（每页约 0.3 MB，原 12MP 原图约 2 MB）；磁盘原图保持不变。`renderBatchPdf` 新增 `options.attachments`，`false` 时只渲染表单页。
- `routes.ts` preview.pdf：
  - 草稿批次默认只渲染表单页（`?attachments=1` 才带附件页，附件原图在对账页右侧单独展示）。
  - 按内容哈希（batch + attachments 标志）内存缓存渲染结果，返回 ETag + `Cache-Control: private, no-cache`，内容未变时 304。
  - 定稿批次返回 ETag + `private, max-age=31536000, immutable`。
- 测试：新增 `test/preview-cache.test.ts` 3 例（ETag/304/编辑后 ETag 变化、2400×1800 噪点图降采样后 PDF 小于原图一半）；`pdf.test.ts`/`category-independence.test.ts` 同步更新默认预览页数断言；两个慢渲染用例 timeout 提到 20s（高负载下并行跑曾偶发 5s 超时）。

## 验证（T03–T05）

- `pnpm typecheck`：3 包全绿。
- `pnpm test`：contracts 25 + api 206 + web 39 全部通过。
- `pnpm --filter @auto-reimbursement/web build`：通过。
- `pnpm test:e2e`：9/9 通过。

## T11 — P-13 手机报销池（缩略图/全选/紧凑列表/触达目标）

- 后端：`GET /api/images/:id?size=thumb` 返回 320px WebP 缩略图（`src/thumbs.ts`，sharp rotate+resize inside，按内容 sha256 落盘缓存于 `dataDir/thumbs/`，`Cache-Control: private, max-age=31536000, immutable`）；缺文件 404 IMAGE_NOT_FOUND、已删除 410 IMAGE_DELETED 语义不变。
- 前端 ReceiptCard：列表只加载 `?size=thumb` 缩略图，点击「查看原图」仍取全尺寸。
- PoolPage：编辑器默认收起、点「编辑」展开（`PoolRow`）；新增「全选可报销（N 张）」；「生成报销单」移入底部吸附栏，实时显示「已选 N 张 · 合计 ¥X」（净额求和）。
- styles.css：按钮/输入框最小高度 44px、勾选框 1.3rem、危险按钮拉开间距、`.pool-selection-bar` 吸附样式。
- 测试：api `test/thumb.test.ts` 2 例；PoolPage.test.tsx 改 2 例 + 新增 2 例（折叠编辑、全选+吸附栏）；e2e/workflow.spec.ts 同步先点「编辑」。
- 验证：typecheck 绿；contracts 25 + api 222 + web 45 全过；web build 过；e2e 9/9。

## T12 — P-14 导航 609–870px 不可达 + 切页跳动

- styles.css：`.app-header` 允许换行；`nav` 所有宽度下 `overflow-x: auto`（原先仅 ≤608px 可滚动，中间宽度被 `overflow-x: hidden` 直接裁掉）；删除 `html, body { overflow-x: hidden }` 遮羞布，改 `html { scrollbar-gutter: stable }` 消除滚动条出现/消失导致的 7.5px 左右跳动。
- App.tsx：新增 `activeNav()`，导航按钮带 `aria-current="page"`，CSS 高亮当前页。
- e2e/nav.spec.ts：375/768/834/1024/1366 五个宽度断言 7 个导航项全部可滚达、页面无横向溢出、「设置」可点击进入且高亮。
- 验证：typecheck 绿；web 45 全过；web build 过；e2e 14/14。

## T13 — P-11 可改商户/日期

- 后端 receipts.ts：新增 `ReceiptPatch`（paidFen/category/merchant/date）与 `assertValidPatch`/`applyPatch`；merchant 去空格、非空、≤50 字（INVALID_MERCHANT 400），date 必须 YYYY-MM-DD 且为真实日历日期（INVALID_DATE 400，拒绝 2026-02-30）；`updateReceipt` 与 `confirmReceipt` 共用校验并应用 merchant/date。
- routes.ts：`receiptPatchFromRequest`/`confirmPatchFromRequest` 接受 merchant/date 并做类型检查。
- learning.ts：`featureFor` 优先使用用户修正后的 `receipt.merchant`，其次才是 AI 识别结果。
- 前端 api.ts：`ReceiptPatch` 类型同步；ReceiptEditor 新增「商户」（maxLength 50）与「日期」（type="date"）输入，随确认原子提交，空商户/空日期前端先拦截。
- 测试：api `test/receipt-patch.test.ts` 3 例（PATCH 修剪与降级、非法商户/日期全拒且原值不变、confirm 后学习规则按修正商户建档）；PendingPage.test.tsx 两处断言同步带 merchant/date。
- 验证：typecheck 绿；contracts 25 + api 225 + web 45 全过；web build 过；e2e 14/14（834px 导航用例曾在高负载并行下偶发 45s 超时，单独与全量重跑均过，列入观察）。

## T14 — P-12 上传可靠性

- 前端 UploadPage 重写提交流程：①逐文件校验（类型仅 JPEG/PNG/WebP、单张 ≤20MB），不合格文件直接列入「上传失败」并给出原因，不拖累其他文件；②`src/compress.ts` 客户端压缩（createImageBitmap+canvas，长边 2000px、JPEG 0.85，>2MB 才压，任何失败回退原图）；③每 3 张一个请求、并发 2（`runPool`），单批网络失败只影响本批；④XHR 上传拿字节级进度（api.ts `upload(files, onProgress)`），drop 区实时显示「正在上传 x/N 张（a/b MB）」；⑤网络失败文件可点「重试失败文件」单独重传（校验失败不重试）；⑥每次选择后重置 `input.value`，重选同批文件也能触发 change；⑦服务端拒绝码翻译为中文原因（格式不支持或图片损坏/超过 20 MB 限制）。
- 服务端：凭证上传 multer fileSize 放宽到 25MB，20–25MB 文件进入 storeImage 按单文件拒绝（201 + rejected IMAGE_TOO_LARGE），不再整单 413；>25MB 仍整单 413 兜底；refund/signature 维持 20MB。
- 测试：UploadPage.test.tsx 新增 3 例（逐文件校验+原因、input 重置、失败文件单独重试）+ 1 例改断言；upload.test.ts 改 20MiB 用例为 201 按个拒绝、新增混合大小用例；合并逻辑对 accepted 数量不一致做了防御。
- 验证：typecheck 绿；contracts 25 + api 226 + web 48 全过；web build 过；e2e 14/14。
- 暂缓（按计划）：PDF/HEIC 上传支持（M–L，列入后续迭代）。

## T15 — P-09 启动自检 + /health 深查（代码部分）

- db.ts：Store 新增 `ping()`（SELECT 1）；四个手工 Store 字面量测试同步补 ping。
- app.ts：/health 在有依赖时做深度检查——store.ping() + DATA_DIR 写探针文件，任一失败返回 503 `{ status: 'error', checks: { database, dataDir } }`；健康时仍返回 `{ status: 'ok' }`（保持监控兼容）；无依赖的裸 app 维持原样。
- server.ts + 新增 `src/volume.ts`：`REQUIRE_VOLUME=1` 时 DATA_DIR 下必须存在 `.volume-id` 标记文件，否则 fatal 日志并拒绝启动（防止卷未挂载时数据静默写到容器临时盘）。
- 测试：`test/health-deep.test.ts` 4 例（健康 200、库挂 503、目录不可写 503、卷标记检测）；health.test.ts 的 hostedConfig 改用真实可写临时 DATA_DIR。
- 验证：typecheck 绿；contracts 25 + api 230 + web 48 全过；web build 过；e2e 14/14。
- 观察：本轮全量测试遇到一次 vitest worker `ERR_IPC_CHANNEL_CLOSED`（高负载并行下的 IPC 崩溃，非测试失败），重跑全绿；与 P-29 一并观察。
- 运维部分（部署时做，不在代码内）：Railway 确认 Volume 挂载并在卷上写入 `.volume-id`、设 `REQUIRE_VOLUME=1`、Litestream/rclone 异地备份、恢复演练手册。

## T16 — P-18 /api/version + railway.json

- config.ts：Config 新增 `commitSha`（读取 Railway 注入的 `RAILWAY_GIT_COMMIT_SHA`，trim，本地为 null）；ai.test.ts / maintenance.test.ts 手工 Config 字面量同步补字段。
- routes.ts：新增 `GET /api/version` 返回 `{ commit }`，用于每次上线核对前后端版本一致。
- 新增根目录 `railway.json`（配置即代码）：NIXPACKS 构建（`pnpm install --frozen-lockfile && pnpm typecheck`）、启动 `pnpm --filter @auto-reimbursement/api start`、健康检查 `/health`（30s 超时）、ON_FAILURE 重启 3 次。
- 测试：`test/version.test.ts` 2 例（有/无注入 SHA）。
- 验证：typecheck 绿；contracts 25 + api 232 + web 48 全过；web build 过；e2e 14/14。
- 运维部分（控制台操作，不在代码内）：GitHub Apps 恢复 Railway 仓库访问、Railway 重连仓库开自动部署、前端页脚显示 Netlify COMMIT_REF（后续迭代）。

## T17 — P-23 时区修正（Asia/Shanghai）

- 新增 `apps/api/src/time.ts`：`BUSINESS_TIME_ZONE='Asia/Shanghai'`，模块级 `Intl.DateTimeFormat('en-CA', …)`（en-CA 输出 YYYY-MM-DD），导出 `businessDate(now)` / `businessMonth(now)`，业务日期/月份与服务器所在时区彻底解耦。
- receipts.ts：删除本地 `localMonth()`，上传归月改用 `businessMonth(now)`；batches.ts：建批 month 同样改 `businessMonth(now)`；settings.ts：`resolveOptions` 默认日期改 `businessDate(now)`，与归月口径一致。
- 问题根因：Railway 默认 TZ=UTC，原 `getFullYear()/getMonth()` 用服务器时区，月初北京时间 0–8 点上传/建批的记录会被错归上个月（如 UTC 9/30 16:30 = 北京 10/1 00:30，旧代码归 2026-09）。
- 测试：`test/time.test.ts` 4 例——跨月边界（UTC 9/30 16:30 → 2026-10）、临界前一秒（15:59:59 → 2026-09）、UTC 零点不跨天、集成（该时刻上传的凭证 month === '2026-10'）。
- 验证：typecheck 绿；contracts 25 + api 236 + web 48 全过；web build 过；e2e 14/14。
- 运维提示（部署时做）：Railway 设 `TZ=Asia/Shanghai` 可让日志时间戳同步为北京时间；代码层面已不再依赖该变量。

## T18 — P-19 CI 流水线 + P-05 界面级回归（附带修复路由/守卫两个真实缺陷）

- 新增 `.github/workflows/ci.yml`：pnpm 11 + Node 24，依次 `pnpm install --frozen-lockfile → typecheck → test → web build → playwright install --with-deps chromium → test:e2e`；push（main 与 feature/mvp-implementation）和 PR 触发。
- `playwright.config.ts`：本地继续用系统 Chrome，CI（`process.env.CI`）改用 Playwright 自带 chromium。
- 新增 `e2e/unsaved.spec.ts`（P-05 界面级回归，报告指出旧 e2e“先保存再生成”测不到）：
  1. 未保存部门时点「生成 PDF」→ 必须先把本地修改 PATCH 保存到服务器再导出（断言调用次序与保存内容）；
  2. 未保存时点导航离开 → 弹确认框，取消则留在原预览页。
- 回归用例牵出两个真实缺陷并已修复：
  - **App.tsx 路由同步重渲染**：hashchange 派发途中 App 的 `setRoute` 被 React 19 同步 flush（浏览器在每个监听器返回后做 microtask checkpoint，queueMicrotask 同样不够），会把注册顺序靠后的预览页守卫监听器在轮到他之前卸载——离开拦截形同虚设。改为 `setTimeout(0)` 宏任务再读最新 hash 更新路由。
  - **PreviewPage 守卫挂载时机**：原守卫挂在依赖 dirty 的被动 effect 上，「编辑→立刻跳转」会在 effect 运行前漏守；改为 dirty 渲染期写入 `useRef`、监听器挂载一次（`[]`）经 ref 读最新值。
- 验证：typecheck 绿；contracts 25 + api 236 + web 48 全过；web build 过；e2e 16/16（新增 2 例）。
- 其余 P-02/03/04/06/10 回归覆盖在前序 Task 已落在 API/契约层（batches/refunds/learning 等测试文件），此处不重复造 UI 级用例。

## T19 — P-29 web 单测稳定性

- 根因：`App.test.tsx` 渲染真实 App 但没 mock `./api`，PreviewPage 挂载后真请求 127.0.0.1:3000；请求在 jsdom 环境销毁后失败，产生 “window is not defined” 的 Unhandled Errors，约半数运行退出码 1。另外 vitest 未开 globals，Testing Library 自动 cleanup 不生效，各测试靠 `getAllBy…().at(-1)` 绕过残留 DOM。
- 修复：`src/test/setup.ts` 显式 `afterEach(cleanup)`；`App.test.tsx` 全量 mock `./api`（含 `UNAUTHORIZED_EVENT: 'api:unauthorized'`）与 `./components/PdfPreview`，`api.batch` 返回最小批次夹具，预览用例改 `findByRole` 等待异步加载，两个用例显式设置初始 hash；`WorkflowPages.test.tsx` 全部 `.at(-1)` 改为 `getBy*`/`findByRole`。
- 验证：web 单测连跑 4 次全部退出码 0、48/48、0 Unhandled Errors；typecheck 绿；contracts 25 + api 236 + web 48 全过；web build 过；e2e 16/16。

## T20 — Minor 批次（P-25/26/27/28/31/32/35/36/37/38）

- **P-32 回收站重复**：`findDuplicates` 拆分 `deletedExactId`（已归档仍走 `exactId` 拦截跨月重复），疑似重复与 `refineDuplicates` 均跳过已删除凭证；上传命中回收站返回 `DELETED_DUPLICATE`；前端显示「重复文件（在回收站）」+「从回收站恢复」按钮。测试：storage-privacy.test.ts 2 例 + UploadPageDeletedDuplicate.test.tsx 2 例；duplicates/upload 旧断言同步。
- **P-35 EXIF 剥离**：`storeImage` 入库前 `rotate()` 转正并重编码（jpeg/webp q92），sha256/感知哈希仍按上传原字节算保证查重稳定；存盘、PDF、缩略图一律无 EXIF/GPS。测试 1 例（含转正后宽高与重上传查重）。
- **P-27 预览竞态**：加载 effect 切换批次先 `setBatch(null)` 并以 active 标志丢弃过期响应；回归测试 1 例（旧批次迟到响应不覆盖新批次）。PdfPreview 的 cleanup destroy 在 T10 已就位，未重复改。
- **P-31**：回收站「恢复凭证」后立即重拉报销池列表（Undo.test 加断言）；历史页归档状态只按未撤销批次计算（原来当月有撤销单时永远显示「归档本月」）。
- **P-28**：`#preview` 无选中批次时新增 `LatestDraftPreview` 自动跳到最近一个未撤销未归档的草稿；预览页撤销后清空 App 记忆的选中批次（不再 409 打开已撤销批次）。
- **P-25**：新增 `errors.ts` `friendlyError`（Failed to fetch 等翻译成「网络连接失败，请检查网络后重试」），接入 PendingPage 与 PreviewPage；待处理页增加「全部重试识别（N 张）」批量重试；上传页 AI 未配置时显示横幅并链接到设置。
- **P-26**：`index.html` 改 `lang="zh-CN"` + 中文标题，页头改「自动报销助手」（e2e/App.test 断言同步）；预览页与设置页日期输入改 `type="date"`；设置保存成功显示「设置已保存」；NoteEditor 支持 Esc 关闭 + 打开自动聚焦；报销池空状态加「去上传」引导；规则表 `merchant/keyword` 显示为「商户/关键词」。
- **P-36**：`form-geometry.json` 标题下划线整体下移 2mm（[19.13, 20.95]，间距不变），不再压字。字体改宋体/楷体类（需嵌入字体文件与授权确认）暂缓。
- **P-37 README**：补 `pnpm dev` 单命令、e2e 前置条件（本地 Chrome / CI chromium）、`ACCESS_CODE_SHA256`/`TZ`/`REQUIRE_VOLUME` 变量与 `.volume-id` 操作、访问码上线后的安全边界段落重写。
- **P-38**：vitest 三包升至 ^4.1.11（GHSA-82fw-gwwq-j7x9 只在 4.1.11+ 修复），顺带升级 multer ^2.4.0（DoS）；`pnpm audit` 已清零；CI 增加 `pnpm audit --audit-level=moderate` 门禁。
- 其他：playwright.config 加 `retries: 1`（高负载并行下导航用例偶发超时，单跑 5/5 稳定，属资源竞争）。
- 暂缓（已记录）：P-25 识别进度服务端恢复（M）、P-26 统一 toast/按钮样式体系、P-28 导航改 `<a>` 链接、P-30 代码质量（lint/单行组件拆分，M）、P-33 基于原单重开草稿（M）、P-34 多用户版本号/审计表（M）。
- 验证：typecheck 绿；contracts 25 + api 239 + web 51 全过；web build 过；e2e 16/16；`pnpm audit` 无已知漏洞。

## T21 全量回归 + 稳定性收尾 + 推送

- **api vitest 池切换**：forks 池在本机 Windows 环境连续两次出现「239 个用例全过后 worker 崩溃 exit 1」的误报；改用 threads 池（`apps/api/vitest.config.ts`），连续运行稳定且更快（11.6s → 5.3s）。
- 最终回归：typecheck 绿；contracts 25 + api 239 + web 51 全过；web build 过；e2e 16/16。
- 推送 origin `feature/mvp-implementation`；推送后 GitHub Actions CI 首次自动运行。

## 第二轮复审修复（Claude，2026-09-29，基于 5de6443）

复审发现本轮改动引入的回归与未生效的修复，逐项修复如下（均先写回归测试确认能复现，再修到通过）：

1. **真实照片导出失败**：P-35 去 EXIF 重编码后，文件索引仍记录上传原始字节的哈希，导出时完整性校验失败（`MISSING_ATTACHMENT`）。`ImageRef` 新增可选 `fileSha256`（落盘字节哈希），`storage.fileIndexSha256()` 供原始凭证/退款凭证写索引；`sha256` 仍是上传指纹，查重不变。新增 `test/export-real-photo.test.ts`（带 EXIF 的 JPEG + 退款凭证 → 预览含附件、导出 3 页）。存量修复脚本 `scripts/repair-file-hashes.mjs`（默认只读，`--apply` 才写）。
2. **对账页凭证图 404**：`ReconcileWorkspace` 把完整 URL 传给 `useAuthedUrl` 被再拼一次 base；改传相对路径，`apiUrl` 遇到完整地址原样返回。测试断言传入的是相对路径。
3. **限流全局共用一个桶**：新增 `TRUST_PROXY`（Railway 上默认 1 跳）；401 单独限速（每 IP 15 分钟 30 次，只计访问码错误）；通用/上传/维护限流移到鉴权之后、按 IP 分桶，上传放宽到 200 次/10 分钟；限流器改为每个 app 实例独立。上传页显示服务器返回的真实失败原因。新增 `test/rate-limit.test.ts`。
4. **先选模板再编辑备注，关联丢失**：`saveSheetNote` 三条路径最后统一 `saveBatchOptions` 保存本页关联与本地选项；移动分类后已保存快照跟随新页面集合（不再误报未保存）；成功操作后清除旧错误提示。
5. **`cancelledAt === null` 判断失效**：正常批次没有该字段，改为 `!cancelledAt`；「生成预览」只自动打开未定稿草稿；历史页归档后显示「取消归档」。
6. **手机对账看不到报销单**：窄屏分类行改为单行横滑；左侧按报销单页（`data-sheet-index`，由 PDF 文本识别）跳转，不再按页码推算。
7. **次要**：客户端压缩改为在上传并发池内按批进行、按像素总量（约 400 万像素）缩放；「重试失败文件」结果追加而不覆盖；确认凭证时商户/日期改为选填；打开 PDF 先同步开窗口再下载（防手机拦截弹窗），草稿链接改为含凭证页的完整预览；含附件的完整预览不再常驻服务器内存。
8. **部署文档**：操作单改正 `/health` 路径、版本核对方式、`REQUIRE_VOLUME` 顺序、脚本说明与 Mac 算哈希命令；README 补 `TRUST_PROXY`；`railway.json` 改用 Railpack（按 `.nvmrc` 安装 24.21.0）、重启策略 `ALWAYS`、健康检查超时 300 秒。

验证：`pnpm typecheck` 通过；`pnpm test` contracts 25 + api 243 + web 60 全过；e2e 16/16（关闭重试）；真浏览器走查：手机照片上传→预览→导出成功、对账页桌面/手机都能看到凭证图、手机上半区能看到报销单、`#preview` 自动打开草稿、归档后显示「取消归档」。

## 试点反馈 Task 1 — 分类规则（Claude，2026-09-30，基于 58bb347）

方案见 `pilot-feedback-plan.md`。解决「武汉仓（百慕达订货小程序）的订单一直被识别成食材」。

- **提示词加分类说明**：`ai/prompt.ts` 新增 `CATEGORY_HINTS`，十个分类各一句业务说明。百慕达食材写明「橙色订单列表、武汉仓字样，不要归为食材；整单以酒水为主归酒水」。要求商户填店铺、小程序或仓库名，keywords 必须包含这些名称，规则才有得匹配。
- **固定规则**：`Rule.source = 'manual'`（可选字段，旧规则视为学习规则）。
  - 设置页手动添加，保存即生效，不再要求确认 3 次。
  - 按「包含」匹配，忽略空格、全半角和大小写。「只看商户」只查商户；「商户或图中文字」查商户、关键词和识别原文。文字至少 2 个字（`RULE_KEY_TOO_SHORT`）。
  - 命中就直接定分类，金额仍按阈值把关。多条固定规则给出不同分类时进待处理（规则冲突），不替人挑。
  - 优先级：人工确认 > 固定规则 > AI。学习记录不会改写固定规则；学习规则可一键「设为固定规则」（同 id）。
- **学习规则冲突**：行为不变，仍进待处理、分类保持 AI 的判断；新增 `Receipt.ruleMatch` 记录规则建议。待处理页写明「历史规则冲突：「武汉仓」以前都归「百慕达食材」，这次 AI 判断为「酒水」」，编辑框可一键「改用规则分类」。
  - 这里与方案初稿「预选规则分类」不同：反馈图 6 的冲突里 AI（酒水）才是对的，改为两边都一键可选。
  - 人工改分类或确认后，建议自动清除；固定规则定的分类在卡片上显示「按固定规则「X」归类」。
- **套用到待处理**：`POST /api/rules/reapply`（`decision.reapplyRules`）用已保存的识别结果重新决策，不调用 AI。只处理仍保持识别原样的待处理凭证；人工改过金额或分类的、疑似重复、识别失败、修改待确认的都不动。返回有变化的张数。
- **使用提醒**：不要给「武汉仓」建固定规则，否则酒水单也会被一律归成百慕达食材。武汉仓的归类交给新的分类说明，固定规则留给「某商家一律算某类」的情况。
- **测试**：新增 `test/fixed-rules.test.ts` 与 `RulesEditor.test.tsx`；扩充 `decision.test.ts`、`category-independence.test.ts`（固定规则改写分类、学习规则仍不改写但给建议）、`ai.test.ts`、`WorkflowPages.test.tsx`、`ReceiptEditor.test.tsx`、`PendingPage.test.tsx`。新增和改写的用例大多在旧代码上失败（当时数过：API 21 个、web 11 个），其余是防回归的守护用例，没有逐个数。

验证：
- `pnpm typecheck` 通过；contracts 25 + api 266 + web 70 全过；e2e 16/16（关闭重试）。
- 手机宽度（390px）真浏览器走查：设置页新建固定规则 → 套用到待处理（1 张变为可报销）→ 待处理页冲突说明与一键改用 → 报销池显示「按固定规则」；页面无横向溢出，无失败请求。

## 试点反馈 Task 2 — 报销单排版（Claude，2026-09-30，基于 Task 1 的 10cf4f5）

方案见 `pilot-feedback-plan.md`。解决「摘要看不到每张金额、不同分类的金额挤在一行、备注偏左上」。分两次提交：先备注居中（提交 A），再摘要排版（提交 B）。

**备注居中（提交 A）**
- `drawNote` 按段落逐段居中：PDFKit 的 `align: 'center'` 会把行尾换行符的宽度也算进去，显式换行的行会偏左约半个字，整段居中做不到真正居中。
- 上下按看得见的高度居中（末行之后多出的一个行距不算）；空行仍占一行，末尾的一个换行不多占一行。超长备注照旧走接续页，放不下仍抛 `NOTE_OVERFLOW`。
- 测试：`form.test.ts`「note box centering」4 例，读 PDF 里的文字坐标（水平误差 < 0.6pt，垂直 < 2.5pt），其中 3 例在旧代码上失败。

**摘要逐张写金额、分类占多行（提交 B）**
- **摘要栏**：每张实报金额按上传顺序写，金额之间隔 4 个空格，一行放不下接着写下一行（逐个往后放的贪心折行，不会重排）。一行大约放 4–7 张，金额位数越多越少：常见的 100 多元一张放 6 张，四位数放 5 张。
- **合并格子**：分类占几行就是它的金额排了几行（至少 1 行）。分类名和金额栏的合计在这几行里上下居中、只写一次；分类内部的横线只留在摘要栏，「报销项目」「金额」两栏不画，像合并单元格。
- **文字居中**：格子里的文字改按字体行框居中；原来的 `(格高-10)/2` 让文字偏下约 3pt，单行的分类也一起修正。
- **超过一张的分类拆开**：先填满当前这张剩下的行，再接新的一张，不浪费空行；一个分类一张放得下就不拆。拆开的每一部分有自己的小计（`FormGroup.part` = 第几部分，从 1 起），第 2 部分起写「食材（续）」。没拆开的分类没有 `part` 字段，接口输出与以前一致。一张报销单的金额合计上限 9999999.99，放不下时同样按金额拆。
- **折行只在一处判断**：`layout.ts` 的 `takeAmounts`。每行放几张、一张报销单放多少、绘制时每行写什么都出自它，排版和绘制不会对不上。
- **分类顺序**：拆开的分类不能单独移动（`CATEGORY_SPLIT`，预览页按钮置灰并写明分在第几页）；没拆开的分类可以移动，只要目标那张的行数放得下（`CATEGORY_TOO_LARGE` 改为按行数判断）。第一页的分类「上一页」置灰。
- **排版校验**（`assertLayoutWithMetrics`）：各部分序号从 1 连续、每部分小计等于自己的金额之和、合起来正好是该分类的全部凭证，同一分类的两部分不能在同一张。
- **旧草稿**：旧版式每个分类只占一行，同样的凭证在新版式下可能一张放不下。预览、导出、移动都会返回 `LAYOUT_OUTDATED`（409）「请到「历史」页撤销本单，再从报销池重新生成」，草稿保持原样、不会半途导出。预览区和「预览完整 PDF」现在显示服务器给的这句话，不再是笼统的「加载失败」。已定稿的 PDF 是不可变文件，不受影响。
- **商户不再印在报销单上**：`Snapshot.merchant` 仍保存，供对账页使用；删除了 `summarizeGroup` 等旧逻辑（缩字号、省略号）。
- **对账页**：报销行标签与报销单一致（`formGroupLabel`：第 2 部分写「食材（续）」）。
- 不在本次范围：PDF 附件页页眉、对账区布局（Task 4）。

**测试**
- `layout.test.ts` 重写（22 例：折行、紧凑拆分、按金额拆分、40 轮随机不变量、合并线、移动、旧版式）。
- `form.test.ts`：摘要同一行按顺序、多行居中、合并线（解析 PDF 内容流里的线段）、拆分与「（续）」；旧断言按新行为改写。
- `batches.test.ts`：拆分创建、`CATEGORY_SPLIT`、排版校验、旧草稿撤销后重新生成；`pdf.test.ts`：拆分后表单页与附件页次序、导出共 42 页；`form-long-merchant.test.ts`：改为商户不上表、预览导出不受影响。
- `contracts`：`formGroupLabel`；web：`PreviewPage.test.tsx`（分类顺序）、`ReconcileWorkspace.test.tsx`、新增 `PdfPreview.test.tsx`、`api.test.ts`。
- API 里新增和改写的 12 个用例在旧代码上失败（用旧源码加新测试对过）。

验证：
- `pnpm typecheck` 通过；contracts 26 + api 296 + web 79 全过；e2e 16/16（关闭重试）。
- 用真实字体渲染 PDF 并逐页查看：3 张同类一行、40 张拆成两张（第二张写「食材（续）」）、10 个分类两张、14 张大额三行合并。

## 试点反馈 Task 3 — 凭证界面精简（Claude，2026-09-30，基于 Task 2 的 22377c4）

方案见 `pilot-feedback-plan.md`。解决「商户和退款太多余，界面繁杂」。只改网页，没有动 `apps/api`。

- **编辑框**：只剩日期（选填）、最终实付金额、分类、确认可报销、删除凭证。去掉商户输入和整块退款（退款金额、全额退款、保存退款、上传退款凭证）。金额框下加一行小字「有退款的，填扣掉退款后实际花的钱」，以后有退款就直接改金额。
- **有旧退款的凭证**：金额框显示扣掉退款后的金额（净额）。确认时发给后台的实付 = 框里的数 + 已登记的退款，所以退款登记不用动，净额恰好是框里的数，不会重复扣，也不会再出现「实付小于退款」。加回退款后超过可记录的最大金额时提示「金额过大」。退款大于实付的旧脏数据，金额框留空，填新数后一并修好。
- **卡片**：标题改成「分类 · 金额」（金额是净额；没识别出来时写「分类待确认」「金额待确认」），下面一行日期。不再显示商户名和内部编号；原金额、已退款、净额三行合成一个金额。旧数据里有退款的，多一行只读的「已扣除退款 X」。缩略图链接和图片的读屏名称、报销池勾选框（「选择 食材 · 120.00」）、「已恢复 …」「已从回收站恢复 …」提示都用同一个写法（新文件 `receiptLabel.ts`）。识别详情、固定规则说明不变。
- **商户**：仍由 AI 识别并保存，用于分类规则和查重；对账页还在显示它，留到 Task 4 一起处理。确认时不再把商户随请求发送（没填就保持原值）。
- **保留**：`api.ts` 的 `setRefund`、`addRefundImage` 和后端接口都没动；历史页的「退款凭证」链接、PDF 附件页的退款信息照旧。
- **样式**：去掉 `.refund-editor`、`.receipt-amounts`；新增 `.field-hint`、`.refund-note`。

**测试**
- 新增 `receiptLabel.test.ts`、`ReceiptCard.test.tsx`；`ReceiptEditor.test.tsx` 重写（没有商户和退款控件、不发送商户、旧退款加回、脏数据、金额过大、必填校验、删除、规则建议）；`PendingPage`、`PoolPage`、`Undo`、`UploadPageDeletedDuplicate` 里的商户名断言改成分类加金额。
- e2e `workflow.spec.ts`：退款三步改为直接调接口登记一笔旧退款，再验证界面显示净额 40.00 和「已扣除退款 80.00」，编辑成 30.00 后批次里 `paidFen 11000 / refundFen 8000 / netFen 3000`，退款凭证仍随批次；`unsaved.spec.ts` 的勾选框名称改为「选择 食材 · 120.00」。
- web 里 23 个用例在旧界面代码上失败（用旧源码加新测试对过），其余是防回归的守护用例。

验证：
- `pnpm typecheck` 通过；contracts 26 + api 296 + web 101 全过；e2e 16/16（关闭重试）。
- 真实浏览器截图（手机 390px、桌面 1200px）：待处理页、带旧退款的报销池卡片、展开的编辑框，排版正常。

## 试点反馈 Task 4 — 对账（Claude，2026-09-30，接在 Task 3 之后）

方案见 `pilot-feedback-plan.md`。解决「报销单与附带图片对账要下滑，下滑后就看不到报销单」，以及附件页只写分类和金额、对不上摘要的问题。网页对账区重做，PDF 附件页页眉改写；`apps/api` 只动了 `render/attachments.ts`，`PdfPreview.tsx`、`form.ts` 没动。

**对账清单（网页）**
- 按「第 N 张报销单 → 分类（张数 · 合计）」列出每张凭证的实报金额（净额，退款已扣）。顺序用报销单上的分组顺序和组内顺序（`FormGroup.receiptIds`），与摘要里的金额、PDF 附件页完全一致；以前对账区自己按上传顺序另排，多个分类拆到几张报销单时会对不上。
- 拆到下一张的分类写「耗材（续）」，张数和位置按这一部分单独算。
- 金额是大字按钮，点一个，凭证图切到那张，当前这张蓝框加粗；上一张 / 下一张走到哪，清单里对应的金额也滚进可见范围；报销单原样同时滚到该凭证所在的那张报销单。
- 凭证图上方一行说明：「第 1 张报销单 · 食材 第 2/3 张 · 本张 19.88 · 食材合计 741.48」；有旧退款的下面再写「原实付 120.00 / 退款 80.00 / 实报 40.00」。工具栏：上一张、「3 / 11」（全部凭证里的第几张）、下一张、放大、缩小、恢复适宽。
- 对账区不再显示商户（含「未识别商家」）；后台仍保存商户。
- 历史页按钮「查看预览」改名「对账 / 查看」；页面标题仍是「生成预览」（e2e 依赖它）。

**布局**
- 手机（窄屏，< 900px）上下分区：对账区总高 = 视口高 − 12rem。上半区默认是清单，最多占四成半高，自己滚动；下半区是当前凭证，图片区自己滚动。「查看报销单原样 / 返回对账清单」按钮把上半区在清单和报销单预览之间切换（预览区最多占一半高）。看凭证时清单不会滚走——这就是反馈 2 的解法。报销单预览（`PdfPreview`）始终挂着，只用样式显示或隐藏，来回切换不会重新加载。
- 窄屏的金额按钮收小一点（最小宽 5rem），常见手机一行放 4 张；工具栏收紧，375px 宽的手机也一行放得下。
- 宽屏（≥ 900px）左右两栏：左边清单在上（最多四成高，自己滚动）、报销单原样在下（自己滚动），右边是凭证；滚报销单时清单不会滚走。
- 横屏手机的收紧规则保留。

**PDF 附件页页眉**
- 新增 `contracts` 的 `receiptCaption`，网页说明和 PDF 页眉共用一个写法。
- 页眉改成两行：第一行是上面那句话，太长就缩小字号（最小 8pt），保证一行、不超出页边；第二行「原始凭证」或「退款凭证」，有退款的后面加「原实付 / 退款 / 实报」（PDF 里不带 ¥）。图片位置不变。附件页次序本来就按摘要顺序，没变。

**测试**
- `contracts`：`receiptCaption` 2 例（普通；「（续）」和两位数张数）。
- 新增 `attachments.test.ts`：读 PDF 文字坐标，两行页眉左对齐页边、行距够；很长的页眉缩小后仍是一行、没超出页边。
- `pdf.test.ts`：附件页页眉整句断言（含退款页、第 2 张报销单、40 张拆成两张后每部分的首尾两张）。
- web：`ReconcileWorkspace.test.tsx` 重写为 12 例（清单与说明、点金额、上一张下一张与计数、组内顺序优先于上传顺序、退款拆解、缩放、没有凭证时无清单无按钮、滚到所属报销单、清单金额滚进视野、窄屏切换清单与报销单且预览不重载、图片加载失败重试、拆页分类的「（续）」）；`Undo.test.tsx`：按钮改名，新增「对账 / 查看」能进入对账区。
- e2e `release-contract.spec.ts`：10 个分类、两张报销单的附件页页眉断言改成新写法。
- 新写和改写的用例在旧源码上失败（用旧源码加新测试对过）：API 3 例、web 11 例。

**验证**
- `pnpm typecheck` 通过；contracts 28 + api 298 + web 106 全过；e2e 16/16（关闭重试）。
- 真实浏览器截图（手机 390px、小屏 375×667、桌面 1280px）：清单、点选高亮、报销单原样切换、退款说明、第 2 张报销单处的清单滚动都正常，页面无横向溢出。

**留意**
- 小屏手机（如 375×667）上凭证图区较矮（约 130px），可以点「放大」、滚动图片区，或横过来看；390×844 这一档约 240px。
- 金额位数多（四位数以上）时，清单一行放的张数会少一些。

## 试点反馈 Task 5 — 截图合并（Claude，2026-09-30，接在 Task 4 之后，基于 cd71ef7）

方案见 `pilot-feedback-plan.md`。解决「同一张订单被截成两张图，会被识别成两个订单、找不到支付金额」。做法：发现疑似同一单时提示，一键合并；也能手动勾选合并；不做全自动合并。合并时服务器把 2–3 张截图左右拼成一张，作为新凭证重新识别，AI、PDF 附件、对账、查重仍是「一单一图」。后端、识别、网页三处都动了。

**合并和拆开（后端）**
- 新增 `apps/api/src/merge.ts`。`POST /api/receipts/merge`（body `{ receiptIds }`，2–3 张、不重复）按给定顺序拼图，建一张新凭证（识别中）并入队，返回这张新凭证；`POST /api/receipts/:id/split` 拆开，返回恢复的来源凭证。
- 拼图：统一成同一个高度（取最高的一张，上限 2800px；总宽超过 8400px 就整体缩小），中间 6px 灰线，认 EXIF 方向，透明底铺白。来源全是 PNG（截图）时输出 PNG（超过 12 MB 改存 JPEG），否则输出 JPEG（质量 92）。不竖着拼：PDF 附件会缩到长边 1600px，竖拼后每张只剩一窄条，字看不清。
- 只有还没进报销单的凭证能合并：状态是待处理或可报销，没删除、没归档、没有退款记录，原图还在，自己不是合并出来的（合并过的要先拆开）。识别中的要等识别完。拼图要读图、花一点时间，所以写库的事务里会按最新状态重新核对一遍。
- 来源凭证原样保留，只是被隐藏（`deletedAt` 加 `mergedInto`）。报销池、识别队列、进度、归档、规则重算、查重、生成报销单本来就跳过已删除的凭证，所以这些地方没有改。合并出来的新凭证带 `mergedFrom`（来源 id，从左到右），沿用最靠前那张的上传顺序和上传时间，在列表里还在原来的位置。
- 拆开：来源凭证恢复成合并前的样子，合并后的凭证、拼出来的图和文件记录都删掉，合并凭证上的识别结果和修改一并丢掉。已进报销单、已归档、在回收站、登记过退款、来源原图已被清理的合并凭证不能拆（各有专门的提示）。
- 回收站里看不到被合并隐藏的来源；对它们点「恢复」提示「请在合并后的那张上点拆开」，删除也不行。合并凭证自己被删进回收站时，来源仍然隐藏，要先从回收站恢复合并凭证，再拆开。
- 重复上传：再传一张已经合并过的截图，提示「已合并进某一单」（`MERGED_DUPLICATE`），上传页给「查看合并后的凭证」的链接。判定顺序：完全相同的在用凭证 → 已合并 → 回收站里的。
- 归档后「清理原图」：合并凭证的来源截图一并清掉（不计入张数）。
- 新增错误码：`INVALID_MERGE`（400），`MERGE_NOT_READY`、`MERGE_NOT_ALLOWED`、`MERGE_IMAGE_MISSING`、`NOT_MERGED`、`SPLIT_SOURCES_MISSING`、`SPLIT_HAS_REFUND`、`MERGED_RECEIPT`（409），都带中文提示。

**识别**
- 提示词说明有拼接图（灰色竖线分隔，整体当作同一单识别，不要把几块小计加起来），并新增两个可选输出：`incomplete`（只拍到订单的一部分、看不到合计或实付时为真，这时金额必须是 null）和 `orderNo`（图里的订单号）。校验里两项都是可选，旧数据和旧返回照常通过。这两项只是辅助判断，不是识别本身，所以模型给了不能用的值（类型不对、空的、超过 100 个字、对不适用的项给了 null）就当没给；订单号全是数字时模型可能给成数字，转成文字收下。不会因为这两项让整张凭证识别失败；识别本身的字段和多余的键仍然严格校验。
- `incomplete` 为真的凭证一律进「待处理」，原因写「截图不完整：可能只是同一单的一部分，可以和相邻的截图合并」；金额也没识别出来时再加上「金额无法确定」。

**疑似同一单（`contracts` 的 `suggestMerges`）**
- 候选：能合并、已经识别过的凭证，待处理和报销池里的一起算。按上传顺序，前后相隔不超过 3 张，上传时间相差不超过 10 分钟。
- 两张都识别出订单号：相同就提示，不同绝不提示，不再看别的。否则商户、日期都不能冲突，至少一项相同，而且其中一张看起来不完整（缺金额、金额有多个候选，或 AI 标了不完整）。商户、日期相同的凭证很多，不够「不完整」就不提示，免得把正常的两张当成一单。
- 每张最多出现在一个建议里；订单号相同的优先，其次最近的，再其次靠后那张。

**网页**
- 待处理页：至少有两张能合并时，卡片出现勾选框，最多选 3 张。选中后底部出现「合并为一单」和「取消选择」，提示还要再选几张。按列表里的顺序从左到右拼。页面上方「疑似同一单」区显示缩略图和依据（订单号相同 / 商户相同 / 日期相同），按钮「合并这 N 张」「不是同一单」（只在本页记着，刷新后还会再提示）。
- 合并后提示「已合并，正在重新识别拼好的图…」，每秒查一次进度（最多 60 次），识别完说清去向：还需要确认就提示看下面的卡片，通过了就写已进入报销池；超时或出错也有提示。这套轮询抽成 `useRecognitionWatch`，待处理页和报销池页共用。
- 报销池页：勾选 2–3 张出现「合并为一单」；选中的里有不能合并的（比如合并过的）时按钮变灰，写「合并过的要先拆开」。
- 卡片上合并出来的凭证多一行「由 N 张截图合并（左右拼成一张图）」；「拆开」按钮在待处理页和报销池页的卡片下面，点了先确认（说明识别结果和修改会丢掉）。
- 样式新增 `.merge-note`、`.merge-suggestions`、`.merge-suggestion*`，`.merge-bar` 里的按钮并排。

**测试**
- `contracts`：`canMergeReceipt`、`suggestMerges`（订单号、商户和日期、不完整才提示、相隔位置、上传时间间隔、每张只用一次、优先顺序）新增 23 例。
- `apps/api/test/merge.test.ts`（新，51 例）：拼图（尺寸、灰线、EXIF 方向、PNG / JPEG、过宽缩小、透明底）；合并（正常、顺序、各种状态拒绝、拼图期间被改动、图片缺失、失败时清掉拼出来的文件）；拆开（恢复原样、可以再合并、各种不能拆的情况）；回收站与恢复；重复上传已合并的截图；归档后清理来源原图；接口错误码；合并图的识别与决策。另有 `decision`（5）、`ai`（3）、`fixed-rules`（1）、`duplicates`（1，并更新 4 处断言）。
- web：`PendingPage`（勾选、合并、疑似同一单提示、不是同一单、拆开确认、识别完成后的去向）、`PoolPage`（8）、`useRecognitionWatch`（5）、`ReceiptCard`（2）、`UploadPageDeletedDuplicate`（1）、`api`（3）。
- 新写和改写的用例在旧源码上失败（用旧源码加新测试对过）：contracts 新增的 23 例、api 50 例、web 29 例。

**验证**
- `pnpm typecheck` 通过；contracts 51 + api 359 + web 142 全过；e2e 16/16（项目配置里导航用例允许重试一次，这次没触发；关闭重试时它偶发超时，已在 `playwright.config.ts` 注明，与本次改动无关）。
- 真实浏览器（手机 390px、桌面）整套流程走通：上传两张半单 → 出现「疑似同一单」→ 合并 → 报销池里变成一张 → 再传其中一张提示已合并 → 拆开 → 手动勾选合并。拼出来的图也看过。

**留意**
- AI 对拼出来的图识别得准不准，没有在真实模型上试过（这里没有真实的密钥，测试用的是替身）。试点时用真实的两张半单截图验一次：如果模型把每半张都当成完整订单、或把正常的完整截图标成「不完整」，调 `ai/prompt.ts` 里 `incomplete` 和拼接图那两段。`incomplete` 为真的凭证一律进待处理，要人确认，所以标得过多的代价是多点几下，不会算错金额。
- 提示偏保守：两张都带金额、又恰好是同一单（比如两半各有一个小计），不会自动提示，要手动勾选合并。手动勾选只能在同一页里选（待处理页或报销池页）；一张在待处理、一张在报销池的，只能靠「疑似同一单」提示合并。
- 拆开会丢掉合并凭证上的识别结果和修改。合并凭证进了报销单之后不能再拆，要拆就先到「历史」页撤销那张报销单。
- 来源截图合并后仍然保存（只是隐藏），所以磁盘上每次合并多一份拼出来的图；归档后「清理原图」会把来源一起清掉。

## 试点反馈 Task 6 — 报销单预览加载失败、对账图太大（Claude，2026-09-30，接在 Task 5 之后，基于 273c83c）

现象：手机上对账页的「报销单」预览加载失败，电脑端左边的报销单预览也加载失败，界面只写一句「加载失败」，看不出原因。当时复现不了用户手机上的具体网络和浏览器，所以没有只修一个点：把最可能出问题的几处一起收紧（少下载、少占内存、失败了说清原因、能重试），后端、前端都动了。

> **更正（2026-10-01）**：上面「网络、文件大小」的判断不完整。推上去之后用户的截图（iPhone 和 Mac 的 Safari）显示，真正的原因是 Safari 不支持 pdf.js 读页面文字用的写法，和网络、文件大小无关，见文末「Task 6 补丁」。下面 6a–6c 的改动本身仍然有效，也正是 6b 的错误提示让真正的错误显示了出来。

**6a 定稿后的预览只下载报销单页（后端）**
- 原来：已定稿的批次，`GET /api/batches/:id/preview.pdf` 返回导出时存的整份 PDF——报销单页后面还跟着每张报销单的全部凭证附件页，凭证多、照片大时有几 MB 甚至更大；而对账页只看报销单页（凭证图在另一边单独看）。慢网、跨境网络下这份下载最容易中断。
- 现在：导出时（`exportBatchPdf`）顺手再存一份「只有报销单页」的 PDF（文件索引 `kind: 'pdf-form'`，id 为 `<PDF 的 id>-form`，几十 KB），定稿后的预览优先返回它：`ETag: "saved-form-<哈希前 24 位>"`，`Cache-Control: private, max-age=31536000, immutable`（内容不会变），支持 `If-None-Match` → 304。没有这份副本（老批次导出时还没有）、文件丢了、哈希对不上，都退回整份 PDF（原来的行为，`ETag: "saved-…"`）。
- 副本只是加速用的：渲染或保存失败只记一条日志，不挡导出；并发定稿时多写的文件会清掉。副本不用于下载、归档，备份里只多一条文件索引；`/api/images/:id` 对它返回 404。
- 数据：测试里 3 张凭证的批次，只含报销单页的副本 15.7 KB，整份 PDF 128 KB；凭证越多、照片越大，差距越大。
- 草稿批次的预览本来就只含报销单页（加 `?attachments=1` 才带凭证页），没有改。

**6b 预览组件说清楚在做什么，失败了说原因并能重试（前端 `PdfPreview`）**
- 加载中显示进度「正在加载报销单… 42%（1.2 MB / 2.8 MB）」，画页时显示「第 2/3 页」；15 秒没收到新数据就提示「网络很慢」并给「重试」（连接卡住时 pdf.js 自己不会报错）。
- 失败时按原因写一句人话（服务器自己说明了原因就用它的）：访问码不对或失效（401/403）、找不到文件（404）、请求太频繁（429）、服务器暂时没响应（502/503/504）、服务器出错（其他 5xx）、网络中断或连不上、PDF 内容不完整、手机内存不足、预览组件没加载下来、其他。都带「重试」，并折叠一份「技术细节」（错误名、状态码、已下载量、用时、浏览器），用户截图发来就能定位。重试从第二次起在地址后加 `retry=N`，绕开浏览器里可能残留的半截缓存。
- 完整 PDF 里的凭证附件页（页眉写「第 N 张报销单 · … 原始凭证/退款凭证」）不画：老批次只能拿到整份 PDF 时，既省内存，也不会满屏凭证。
- 新增两个可选参数：`minWidth`（每页至少按这么宽画，窄屏用，见 Task 7；不给就缩放到容器宽）、`onSheetDrawn`（每画好一张报销单页通知一次，对账区据此在预览晚到时仍能跳到当前凭证所在的那张）。

**6c 对账用的凭证图给缩小版（后端 + 前端）**
- `GET /api/receipts/:id/original-image?size=view`：原图超过 1.5 MiB 才给缩小版——长边不超过 3200px、JPEG 质量 82（认 EXIF 方向、透明底铺白），而且缩小后要小到原图的 80% 以下才用，否则还是发原图；缩小版按内容哈希缓存在 `thumbs/<sha256>-view.jpg`。1.5 MiB 以下的图（上传时已压缩的照片一般 1 MB 上下）原样返回，不重新编码；转换失败也退回原图（记一条日志）。不带 `size` 的请求行为没变，「查看原图」仍是原图。
- 对账页一律请求 `size=view`。拼图里每张截图缩小后仍有 1000px 左右宽，读字足够。数据：一张 4.08 MB 的手机大图，缩小版 1.56 MB。
- 凭证图的下载可以取消（`fetchBlobUrl(path, signal)`，`useAuthedUrl` 在换图或离开页面时取消还没下完的请求）：慢网下连点「下一张」不会让好几张大图同时抢带宽，只下当前看的这一张；失败时带上原因（「无法连接服务器」等）。

**合并凭证记下每张截图的位置（后端，Task 7 要用）**
- `ImageRef.panels?: Array<{ left; width }>`：每张截图在拼图里的位置（像素，从左起，不含 6px 分隔线）。`stitchImages` 算出来，`mergeReceipts` 存进新凭证的 `original`，随报销单快照一起保存。单张图和老数据没有这个字段。

**测试**
- api：`view-image.test.ts`（新，6 例：大图给缩小版并缓存、原图不动；小图原样、不重新编码；缩小省不了多少就发原图；透明底铺白；大文件解不开时退回原图；缺失的凭证、文件、已清理的原图仍报原来的错误）；`pdf.test.ts`（导出时存下只含报销单页的副本、重复导出不重复存、下载仍是整份；定稿后的预览用副本，长缓存、带 ETag、支持 304；整份被换掉时预览不受影响；副本损坏时退回整份；老批次没有副本时用整份；草稿没有副本、副本不能当图片取；副本存不进去不挡导出且不留临时文件；并发定稿时多写的两份文件都清掉）；`merge.test.ts`（`panels` 的位置对得上拼图：顺序、三张、EXIF 旋转照片、超宽缩小后、回退成 JPEG 时、存进合并凭证）；`batches.test.ts`（`panels` 带进报销单快照）。
- web：`PdfPreview.test.tsx`（服务器说明的原因、按状态码解释网关错误、不为读原因再下一遍整份、断网说原因并能重试、技术细节、浏览器画不出和网络问题分开、下载进度、慢网提示、只画报销单页并标序号且跳过附件页、`onSheetDrawn`、`minWidth`）；`AuthedImage.test.tsx`（新：带访问码下载、保留失败原因、换图或离开时取消下载、取消不算失败、缩略图组件）；`api.test.ts`（`fetchBlobUrl` 可取消且取消不当成断网、断网时仍说连不上服务器）。

**验证**
- `pnpm typecheck` 通过；contracts 51 + api 376 + web 189 全过；e2e 19/19（含新增的 3 条，关闭重试）。
- 新写和改写的用例在旧源码上失败（用旧源码加新测试对过）：api 11 例、web 30 例；`VoucherViewer`、`useMediaQuery` 是全新模块，不在统计里。没失败的是「保持旧行为」的守卫用例（小图原样、没有副本时用整份、副本存不进去也能导出等）。
- 真实 Chromium（手机 390×664）：定稿批次的预览只请求并画出报销单页；断网时凭证图说「无法连接服务器」，服务器返回 503 时预览说「服务器暂时没有响应（503）」并给技术细节，恢复后点「重试」都能正常显示（这两条已写进 e2e `reconcile-phone.spec.ts`）；限速到很慢时也看过。

**留意**
- 老批次（做这次改动之前定稿的）没有「仅报销单页」副本，预览仍要下整份 PDF；服务器没法从旧 PDF 里切出报销单页（没有 PDF 编辑库）。在历史页撤销那张报销单、重新生成并定稿后才会有副本。
- `size=view` 只对超过 1.5 MiB 的图起作用；上传时已压缩过的普通小票本来就小，不受影响。
- 开发模式下 React StrictMode 会让预览请求多发一次，生产构建没有。
- 没有解决的：服务器在境外（Railway）、前端在 Netlify，国内手机访问本身就慢且不稳。这需要换部署（Task 8，方案里单独列了，等确认门店和老板所在地、预算、备案主体后再做）。

## 试点反馈 Task 7 — 手机对账重做（Claude，2026-09-30，接在 Task 6 之后）

现象：手机上对账页显示不全。清单、报销单预览、凭证图在一整页里上下堆着，凭证图区只有 140–239px 高（390px 宽的手机上一张图只露出一条），要在很长的一页里来回翻。只改前端；电脑（≥900px）的布局和行为不变。

**窄屏（≤899px）：一次只显示一块**
- 顶部三个标签：「凭证」（默认）、「清单」、「报销单」，整屏切换。「凭证」里是说明、翻页、凭证图，凭证图占满剩下的高度（390×664 的手机上约 362px，原来 140–239px）；对账区的高度按屏幕算（`100dvh` 减去页头和标题），横屏矮屏另有一套。
- 在「清单」里点一个金额，直接切到「凭证」看那一张；清单高亮和凭证同步。
- 「报销单」标签第一次点开才开始加载预览（先把带宽留给凭证图），点开过就一直留着，来回切换不重新加载；窄屏上报销单页按至少 960px 宽画（270×165mm 的横版缩到 390px 字只剩 5px 左右，看不清），在区内上下左右滑动。
- 「全屏查看」：整屏黑底盖住页面，上面是「关闭全屏」和说明，中间图撑满（可滑动、双指捏合），下面是上一张 / 第几张 / 下一张、放大 / 缩小 / 适宽、截图切换。Esc 关闭，打开时锁住背后页面的滚动，关闭后焦点回到「全屏查看」按钮，缩放复位。手机上行内工具栏不放缩放按钮，缩放在全屏里。
- 说明文字（第 N 张报销单 · 分类 第 i/n 张 · 本张 X · 分类合计 Y）不在「食材合计」这样的词中间断行。

**合并凭证逐张截图看**
- 合并出来的凭证（Task 5）拼成一张宽图，整张缩到手机宽度字就看不清。现在有「截图 1 / 截图 2 / 整图」按钮：看某一张时，图宽按「这一张刚好撑满容器」算，滚动位置对在这一张的左边缘；换凭证时从第一张截图看起；「整图」适宽、从最左边看起。
- 位置来自 Task 6 记下的 `panels`（像素），页面把它换算成占整张图宽度的比例再用，所以对账用的缩小图（6c）也对得准。数据对不上整张图的宽度时，或者是记位置之前合并的老凭证（没有 `panels`），只给整图。
- 新增 `VoucherViewer.tsx`（滚动查看区，`panelFractions` 把像素换成比例）、`useMediaQuery.ts`（窄屏判断）；`ReconcileWorkspace.tsx` 重写。

**顺手修了一个老问题**：全局样式 `img { max-width: 100% }` 让「放大」在真实浏览器里没有任何效果（图被压回容器宽，单元测试在 jsdom 里看不出来），现在凭证图区里的图 `max-width: none`。

**测试**
- web：`ReconcileWorkspace.test.tsx` 重写为 28 例（清单与说明、点金额、翻页与计数、组内顺序、退款拆解、缩放、窄屏三个标签一次只显示一块、点清单金额切到凭证、宽屏直接画报销单、预览晚到时跳到所属报销单、合并凭证逐张截图 / 整图、在选中的截图上放大、滚到所选截图的左边缘、换凭证回到第一张截图、位置对不上或没有 `panels` 时只给整图、全屏的打开 / 关闭 / Esc / 焦点 / 滚动锁、全屏里也能切截图、加载慢与失败说原因并重试、离开的那张凭证停止下载）；`VoucherViewer.test.tsx`（新，5 例：像素换成比例、图缩小后仍对得准、三张截图、数据不可信时不给分屏、右边缘差一个像素也认）；`useMediaQuery.test.tsx`（新，3 例）。
- e2e：新增 `e2e/reconcile-phone.spec.ts`（3 条），用真实接口造一份报销单（含一张由两张截图合并的凭证）：
  - 手机 390×664：凭证图区不低于视口高度的 45%；报销单预览在第一次点开前不发请求；标签一次只显示一块；点清单金额切到凭证；每张截图撑满屏幕宽且滚动位置对准；「整图」适宽；全屏盖满屏幕、能放大和适宽、Esc 关闭后焦点回到按钮；报销单页画得不小于 900px 宽；页面没有横向溢出。
  - 手机 390×664，加载失败：凭证图断网时说「无法连接服务器」、预览返回 503 时说明原因并给技术细节，恢复后点「重试」都能显示。
  - 电脑 1280×800：清单、报销单、凭证同屏，没有标签和全屏按钮。
  - 故意把 8 处功能改坏（凭证图 `max-width` 改回 100%、凭证区改矮、截图不对位、预览提前加载、点金额不切标签、报销单页缩到屏宽、失败原因丢掉、「重试」不起作用）都会被这几条测试抓到。

**验证**
- 同 Task 6：`pnpm typecheck` 通过；contracts 51 + api 376 + web 189 全过；e2e 19/19。
- 真实 Chromium：手机 390×664、电脑 1440×900，走了清单、点金额、翻页、全屏、合并凭证、放大、报销单标签；页面无横向溢出。

**留意**
- 小屏手机上凭证图区的高度跟屏幕高度走（390×664 约 362px）；更细的字用「全屏查看」，或双指捏合。
- 报销单页在手机上要左右滑动看（字才是能读的大小）；整张一眼看全做不到，需要时在电脑上看。
- 记位置之前合并的老凭证没有 `panels`，只能看整图；还没进报销单的话，拆开再合并一次就有了。
- 浏览器自带的滚动条会让「全屏查看」右边留出约 15px 的页面条（桌面浏览器窗口很窄时才看得到，手机是浮动滚动条，没有）。

## 试点反馈 Task 6 补丁 — 报销单预览在 Safari 上全部加载失败（Claude，2026-10-01，接在 Task 7 之后，基于 c273a78）

现象：Task 6/7 推上线后，用户在 iPhone（iOS 18.6、Safari 18.6）和 Mac（Safari 26.5）上，对账页的报销单预览都显示「预览加载失败：浏览器没能显示这份 PDF」，技术细节是 `TypeError: undefined is not a function (near '...i of e...')`，同一屏还写着「已下载 17 KB / 17 KB」。只改前端。

**真正的原因（之前说的网络、文件太大都不对）**
- 文件早已完整下载（17 KB / 17 KB），出错在浏览器里读页面文字这一步。`PdfPreview` 为了认出凭证附件页和报销单页，对每一页调用了 pdf.js 的 `page.getTextContent()`（第二轮评审时加的，commit 58bb347）；pdf.js 6 里这个函数内部是 `for await (const chunk of readableStream)`。Safari 到 26.x（iPhone 上的 18.x 也一样）的 `ReadableStream` 不支持 for await，Safari 27 才加，所以一调用就抛 TypeError。其他主流浏览器的新版本支持，这条路在它们上一直正常。
- 为什么一直没测出来：web 单元测试把 pdf.js 整个换成了假的；e2e 只跑 Chromium，而 Chromium 支持这个写法。Task 6 当时「复现不了」，转而收紧下载、报错、重试的那几处改动本身是对的（也正是它们让真实错误显示了出来），但没有碰到真正的原因。

**怎么确认的**
- 在云端装了真正的 WebKit 引擎（WebKitGTK 2.52 + WebKitWebDriver，和 Safari 同一个内核的移植）。它比 Safari 26.5 新，已经支持 ReadableStream 的 for await，所以旧代码在它上面本来跑得通；把页面里 `ReadableStream.prototype` 的 `Symbol.asyncIterator` 和 `values` 删掉来模拟 Safari 26 之后，旧代码的生产构建出现和用户截图一模一样的失败：「浏览器没能显示这份 PDF」，细节 `TypeError: undefined is not a function (near '...i of e...')`。手机尺寸（点开「报销单」标签）和电脑尺寸都一样。
- 外部资料也对得上：caniuse 上 ReadableStream 的 `[Symbol.asyncIterator]`，Safari 桌面版和 iOS 版都是 27 起支持；也有别的项目在 Safari 26 上因为 pdf.js 6 的 `getTextContent()` 出同一个错，改成直接读 `streamTextContent()` 修好。

**修改（`PdfPreview.tsx`）**
- 不再调用 `getTextContent()`，改成 `pageText(page)`：对 `page.streamTextContent()` 用 `reader.read()` 一块块读，读完放掉读取器。所有浏览器行为一致。
- 读不出某一页的文字（例如 worker 已被销毁）不再让整份预览失败：这一页照样画出来，只是不标第几张报销单、也认不出附件页，并在控制台记一条警告。
- 失败时的「技术细节」多带堆栈前 4 行（去掉域名；V8 的堆栈第一行和错误名重复，不再列）。下次再出现看不懂的失败，能看出是哪一行代码抛的。

**测试**
- web `PdfPreview.test.tsx`（12 → 16 例）：假页面的 `getTextContent()` 照 Safari 的样子直接抛错，文字只能从 `streamTextContent()` 的读取器里读（分成两块，中间夹一个没有 str 的标记项，关键词可以被拆在两块之间）。新增：用读取器读文字并放掉读取器、读不出文字时仍画出整页但不标序号、堆栈行进技术细节（V8 和 JavaScriptCore 两种格式）。
- e2e：新增 `e2e/safari.ts` 的 `pretendToBeSafari(page)`（页面里删掉 `ReadableStream.prototype` 的 asyncIterator 和 values，模拟 Safari 26 的缺口；pdf.js 的 worker 是另一个运行环境，不受影响），`reconcile-phone.spec.ts` 的每条用例都先调用它；另加一条「替身自检」确认页面里 for await 确实会抛 TypeError（4 条，原来 3 条）。**以后凡是要在页面里真跑 pdf.js 的 e2e 都应先调用它。**
- 故意改坏都会被抓到：改回 `getTextContent()`（web 3 例失败；e2e 手机、手机重试、电脑三条都在等报销单画出来时超时）；去掉读不出文字时的兜底、不放读取器、不带堆栈、堆栈带域名、重复错误行、不截断堆栈各 1 条，共 7 处，每处都有测试失败。

**验证**
- `pnpm typecheck` 通过；contracts 51 + api 376 + web 193 全过；e2e 20/20（关闭重试）。
- 真 WebKit（WebKitGTK 2.52，页面里删掉 ReadableStream 的 asyncIterator）：旧代码在手机和电脑尺寸都复现用户的失败；新代码在手机尺寸（点开「报销单」标签）画出一张 960px 宽的报销单，电脑尺寸画出报销单并标了序号。

**留意**
- 云端用真 WebKit 复现的做法（只在这次手工做的，脚本没有放进仓库）：`apt-get install webkit2gtk-driver libwebkit2gtk-4.1-0 xvfb`，起 `Xvfb :99` 和 `WebKitWebDriver --port=4444`，用 WebDriver 新建会话（`browserName: MiniBrowser`，`webkitgtk:browserOptions.binary` 指向 `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser`、参数 `--automation`），打开用 `vite build` 构建的页面。因为 WebKitGTK 比当时的 Safari 新，要先在页面里删掉 `ReadableStream.prototype` 的 `Symbol.asyncIterator` 和 `values` 才像 Safari 26。
- 真 Safari 里的其他不兼容只能靠用户在真机上试；修复推上去后请再用 iPhone 和 Mac 的 Safari 各看一次预览。万一还有别的报错，「技术细节」里现在有堆栈，截图发来就能定位。
- Safari 27 起支持 for await，但这里的写法在所有版本都能用，不需要再改回去。

## 公账付款区 Task 9 — 隔离地基（Claude，2026-10-01，基于 f489d1e；方案见 `company-ledger-plan.md`）

做了什么：新增「公账付款」区的数据地基，后端按区域把店内报销和公账付款完全隔开。这一步只动契约和后端，没有改任何店内行为，前端只为类型检查通过改了一处（`PoolPage` 的 `byCategory` 取值加 `?? 0`）。

**契约（`packages/contracts`）**
- 新增 `COMPANY_CATEGORIES`（当时是肉款、品牌管理费、店面租金、物业费、水电空调、其他公账支出六类；第 10 步按使用者反馈改成了八类，水电空调拆成水费、电费、空调能源费，见下一节），`StoreCategory`、`CompanyCategory`，`Category` 变成两者并集，`ALL_CATEGORIES`；`Ledger = 'store' | 'company'`、`isLedger`、`ledgerOf`（缺省或不认识都是店内）、`categoriesFor(ledger)`、`categoryLedger(category)`。
- `Receipt.ledger?`、`Batch.ledger?`：店内的凭证和批次不写这个字段，存下来的 JSON 和以前一样，老数据不需要迁移，回滚到 f489d1e 也读得了。`Totals.byCategory` 改成 `Partial<Record<Category, number>>`；`UploadResult.rejected[]` 多一个可选的 `duplicateLedger`。

**后端按区域隔离**（没带 `ledger` 参数的请求都等于店内；写了不认识的值返回 400 `INVALID_LEDGER`）
- 上传 `POST /api/receipts/upload?ledger=company`（multer 不允许带表单字段，所以用查询参数）；凭证列表、汇总 `?ledger=`；历史、归档、取消归档、清理原图都只动本区；规则 `GET /api/rules?ledger=`、`POST /api/rules/reapply?ledger=`。
- 分类校验按凭证所在的区：店内凭证只能选店内分类，公账凭证只能选公账分类（确认、修改）；移动分类、规则这类不分区的地方认两个区的全部分类。
- 规则属于哪个区由它的分类决定，不加字段；`decide()` 只看本区的规则；学习到的公账规则 id 带 `company:` 前缀，同一个商户名在两个区是两条互不相干的规则。
- 查重：完全一样的图，另一个区有「在用」的同一张也拒绝（拒绝信息带 `duplicateLedger`，说明在哪个区）；另一个区回收站里的同一张不算（传错区后可以删掉重传）；相似图判断只在本区比，公账区上传时不做相似图判断（银行回单模板一样，会误报），识别后仍按金额、日期、收款方、图相似二次判断（只在本区）。
- 合并截图只能合并同一区（`MERGE_MIXED_LEDGER`），合并出来的凭证继承区域；一个批次只能装一个区的凭证（混了 409 `MIXED_LEDGER`），公账批次记 `ledger: 'company'`；公账不支持退款（409 `REFUND_NOT_SUPPORTED`）。
- 新增拦截 `LEDGER_DUPLICATE`（409）：在这个区删除、又传到了另一个区的同一张图，不能再从回收站恢复回来；合并凭证拆开时也一样检查。免得同一张图在两个区都在用、入两次账。

**测试**
- 新增 `apps/api/test/company-ledger.test.ts`（33 例）：上传、列表、汇总各区互不出现；不认识的区 400；查重（跨区拒绝并说明在哪个区、删除后在对的区重传、同区回收站照旧、相似图只在店内判断且公账区不判断、两区都在用时指本区那张、识别后二次判断不跨区）；批次、历史、归档、取消归档、清理原图各区互不影响（含 HTTP 接口，另一区没做完的事不挡住这一区）；规则列表、固定规则、重新套用、识别时套用、学习规则 id 都按区；分类校验、退款、合并、拆开。
- 故意改坏 39 处隔离逻辑（去掉过滤、去掉混区拦截、接口忽略区参数等）逐个验证：第一轮 34 处里 29 处被抓到，没抓到的 5 处补了测试；又为新拦截、清理和取消归档接口加了 5 处；最后 39 处全部都会被新测试抓到。
- 现有测试原样通过：contracts 51、api 376 + 新增 33 = 409、web 193；`pnpm typecheck` 通过（api 和 web）。

**留意**
- 这一步只是地基：公账区还没有自己的 AI 提示词和校验（Task 10）、通知单多项明细（Task 11）、付款单版式（Task 12）、前端页面（Task 13）。
- 同一张图要从店内挪到公账区，办法是在传错的区删除、再传到对的区；没有「移到另一个区」按钮（见方案「以后」）。

## 公账付款区 Task 10 — 公账识别（Claude，2026-10-01，基于 ae66e92；方案见 `company-ledger-plan.md`）

做了什么：让公账区自己认银行回单和收费通知单（单独的提示词和校验），并按使用者看了通知单后提的两条要求改了设计：**水费、电费、空调能源费各自独立成项且带费用月份**，**收款户名、开户银行、银行账号要写进付款单备注栏**。这一步只动识别和判断，数据落到凭证上，还没进入待付款池汇总和付款单（Task 11、12），前端只多了一条待处理原因的文案。

**设计变化（相对 Task 9 的方案）**
- 公账分类从六类改成八类：肉款、品牌管理费、店面租金、物业费、**水费、电费、空调能源费**、其他公账支出（兜底，装修款、广告费这类也能记）。Task 9 的「水电空调」一类取消。
- 一项费用可以带月份（`period`，`YYYY-MM`）：通知单每个收费项目一个月份，回单用途里写了月份也会读；同分类不同月份是不同的行（例：电费 2026年7月、租金 2026年9月）。月份认不出就当没有，可以在对账页补。
- 收款方（`payee`：收款户名、开户银行、银行账号）AI 从回单、通知单上读，可改，付款单备注栏打印。这**取代**了方案原来的「系统不识别、不保存账号」：账号只放在 `payee.account` 这一个字段，依据、关键词、商户名里的账号一律抹成 `****`，不进日志；AI 读出的位数必须在对账页对着原图核对。

**契约**：`isPeriod`、`parsePeriod`（认 `2026-7`、`2026年7月`、`2026/07`、`202607`、全角数字等写法）、`formatPeriod`（`2026-07` → `2026年7月`）；`Payee`、`ReceiptLine`（分类、分、可选月份）、`AnalysisLine`；`Analysis` 和 `Receipt` 多可选的 `lines`、`period`、`payee`；待处理原因多 `lines_mismatch`（各项加起来和合计对不上）。

**识别**
- 新增 `apps/api/src/company.ts`（纯函数，不碰数据库和 AI）：收费项目名称 → 分类（品牌/加盟 → 品牌管理费；租金/房租 → 店面租金；物业/物管/管理费 → 物业费；空调/能源/能耗 → 空调能源费；电费/电力/用电 → 电费；水费/用水/自来水 → 水费；顺序保证「品牌管理费」不被当成物业费、「空调电费」算空调能源费）；**水电合写（「水电费」「水电空调」）不猜，落到「其他公账支出」并让人拆**；同（分类、月份）的合并；收款方清理；账号抹除。
- 新增公账提示词 `COMPANY_PROMPT` 和宽松校验 `validateCompanyAnalysis`：金额带 `¥`、千分位、「人民币」都规范化；日期按银行的写法认；认不出的分类当「没认出」而不是整张识别失败；月份认不出丢掉；收费项目最多读 20 条；账号从依据、关键词、商户名里抹掉。店内提示词和严格校验一字未动，店内调用 `analyzeReceipt(image)` 仍是一个参数，只有公账才多传 `{ ledger: 'company' }`。
- 判断：通知单（至少两项，或一项但认得出）按明细判断，不看规则也不看 AI 的分类置信度：金额照常把关（置信度低、多个候选、截图不完整），各项之和必须等于合计（否则 `lines_mismatch`），有认不出的项目要人看一眼（`category_uncertain`）；只有一项又认不出的当回单处理；回单是单分类，沿用 AI 的分类和固定规则，回单上写的月份保留。每次重新识别都先清掉旧的明细、月份、收款方；店内凭证绝不会带公账字段。「套用到待处理」对明细凭证原样不动（规则不起作用）。

**测试**
- 新增 `apps/api/test/company-ai.test.ts`（70 例）：真实的两张回单和通知单当验收（回单 → 肉款/品牌管理费，带收款方；通知单 → 租金 9 月、物业费 9 月、水费 7 月、电费 7 月、空调能源费 7 月，合计 39,561.63 直接进待付款池）；各种收费项目名称映射；合并和不合并；合计对不上、有认不出的项目、金额没把握、截图不完整各自的待处理原因；校验的各种脏输入；账号抹除只在收款方里留；队列里公账传区参数、店内不传；重新识别清旧数据；重新套用规则不动明细凭证（含「模型很有把握、规则也能命中」的情况）。测试里的账号都是编的假号码，真通知单上的号码没有出现在代码、测试、文档里。
- contracts 51 → 57（月份写法、区和分类的辅助函数）。
- 故意改坏：公账识别 46 处（映射顺序、合并、金额规范化、校验、清旧数据、传区参数……）第一轮 45 处里 44 处被抓到，漏的一处（重新套用时没按明细判断）补测试后抓到；contracts 的月份和区辅助函数 16 处全部被抓到。
- 全部测试：contracts 57、api 479、web 193 通过；api 和 web 类型检查通过。

**留意**
- 真实的 DeepSeek 对银行回单和通知单的识别还没有实测，等有真图和密钥时要试一次；通知单项目名称若有这里没覆盖的叫法，会落到「其他公账支出」并提示人看一眼，可以随时补关键词。
- AI 读 19 位银行账号可能错位数，对账页要把账号和原图并排显示核对（Task 13）。
- 首次使用时可在设置页的公账区加固定规则（例如「新沣」→ 肉款、「品牌管理」→ 品牌管理费），回单就不用每次靠 AI 判断分类。

## 公账付款区 Task 11 — 多项明细、月份、收款方贯穿（Claude，2026-10-01，基于 0c7f388；方案见 `company-ledger-plan.md`）

做了什么：把第 10 步读出来的「明细、月份、收款方」接进待付款池、批次、排版和附件页，并且可以在编辑（修改、确认）里改。付款单的标题和备注栏（Task 12）、前端页面（Task 13）还没做；店内凭证、店内批次存下来的数据和排版和以前完全一样。

**一行 = 分类 + 月份**
- 契约：`FormGroup` 多可选的 `period`；`groupKey(group)`（`分类` 或 `分类|月份`，各处判断「是不是同一行」都用它）、`linesTotalFen`、`formGroupLabel`（`电费（2026年7月）`，拆在多张单上的第 2 部分起加「（续）」）；`Snapshot` 多可选的 `lines`、`period`、`payee`；`receiptCaption` 的入参多带月份。
- 汇总（`poolTotals`）：多项凭证按各项金额分到各自的分类，张数按凭证算；通知单的 39,561.63 分到五个分类里。
- 分行（`groupItems`）：一行是（分类，月份），同分类不同月份是两行，同分类同月份合成一行；多项凭证展开成几行，同一张凭证在几行里各出现一次；店内的行不带 `period` 这个键，存下来的 JSON 和以前一样。
- **一张通知单的各行排在同一张单上**（`packGroups` 的 `keepTogether`）：连着的几行里有同一张多项凭证，就算一块；本张剩下的行放不下这一块、但新的一张放得下时，整块换到新的一张。例：两张回单加一张通知单 → 第 1 张 [肉款、品牌管理费]，第 2 张 [通知单的 5 行]。一张都放不下的才接着排。店内不传这个参数，排版和以前完全一样。
- 移动分类：请求可带 `period`，（分类，月份）才定位到行；`moveGroup`、`moveBatchGroup`、版式校验（`assertLayoutWithMetrics`）都按 `groupKey` 判断，同分类不同月份分得开。
- 附件页：一张凭证在一张单上只出一页（多项凭证出现在几行里也一样）；通知单的说明写成「第 N 张报销单 · 本张凭证 X，含 K 项」加每项的「分类（月份） 金额」，页眉高度按行数自适应，图不会被盖住。
- 退款池（`isEligible`）：多项凭证各项之和必须等于净额才算可用。

**编辑接口（`PATCH /api/receipts/:id`、`POST /api/receipts/:id/confirm`）**
- 新字段 `lines`（2～20 项；分类只能是公账分类；金额是 1～999,999,999,999 的整数分；月份 `YYYY-MM`，可以不写；（分类，月份）不能重复）、`period`（单分类凭证的月份，`null` 或空串清掉）、`payee`（户名、开户银行、银行账号，严格校验：账号必须是字符串、去掉空格和横线后 6～34 位字母数字；三项都空等于去掉）。店内凭证带这些字段返回 `INVALID_RECEIPT_PATCH`。
- 给了 `lines`：金额以各项之和为准（同时给了不一样的金额返回 409 `LINES_SUM_MISMATCH`），分类取第一项（给了别的分类返回 `INVALID_CATEGORY`），不能再带单独的 `period`（`INVALID_PERIOD`）；`lines: null` 拆回单分类。确认时一定检查各项之和等于合计；修改时只有动了金额或明细才检查。多项凭证不学规则；改了明细，原来的规则说明（按规则归类 / 规则建议）清掉。
- 新错误码：`LINES_SUM_MISMATCH`（409）、`INVALID_LINES`、`DUPLICATE_LINE`、`INVALID_PERIOD`、`INVALID_PAYEE`（400），都带中文提示。

**测试**
- 新增 `apps/api/test/company-lines.test.ts`（63 例）：明细输入的各种脏数据；汇总；分行（同分类不同月份、同月份合并、多项凭证展开、店内行不带月份）；整块换页（含「夹在中间的无关行不跟着换页」「只认点了名的凭证」）；移动分类（带月份、HTTP 接口）；编辑接口（拆开、合回去、只改金额不给明细被拒、规则说明、不学规则、收款方和月份的校验）；批次快照；退款池；附件页（一页一张、说明、页眉高度）；真实例子（两张回单加一张通知单 → 汇总、排版、生成 PDF 的附件页）。附件页另加 3 例页眉高度；contracts 57 → 61。
- 故意改坏 70 处（明细输入校验、收款方清理、分行、整块换页、移动分类、汇总、快照、编辑接口、附件页……）：第一轮 65 处被抓到，没抓到的 5 处里 3 处是真漏洞（整块换页的「编号没清」「不看点名」、改明细后规则说明没清掉），补测试后重新验证全部被抓到；另 2 处行为等价，不补（快照里 `structuredClone` 的防御性复制；批次里把所有凭证都点名，因为只有多项凭证才会占好几行，结果一样）。
- 全部测试：contracts 61、api 545、web 193 通过；api 和 web 类型检查通过。

**留意**
- 这一步没有动前端：编辑框、对账页还看不到明细、月份、收款方（Task 13）；付款单上还写着「费用报销单」「报销部门」，备注栏也还没打印收款方（Task 12）。
- 「按收款方分页」没做（方案「以后」）：一张单上有几个收款方，第 12 步在备注栏里缩字号放，放不下接到备注续页。

## 公账付款区 Task 12 — 付款单 PDF（Claude，2026-10-01，基于 094abcc；方案见 `company-ledger-plan.md`）

做了什么：公账批次生成的 PDF 换成「公账付款单」的叫法，项目栏写费用月份，备注栏打印这张单上的收款方（户名、开户银行、银行账号），附件页页眉写「付款单」，设置里加「公账付款单位」。店内的 PDF 一个字节都没变（用改之前的 `form.ts` 逐字节比对过 10 种店内情形，见下）。前端页面（Task 13）还没做，网页要接的几处见「留意」。

**单据上的字**（`render/form.ts` 的 `formWords`）
- 公账：标题「公账付款单」、左上「付款单位：」、表头「付款项目」、页脚「经办人」；店内仍是「费用报销单」「报销部门：」「报销项目」「报销人」。每组字的字数相同（5、5、4、3），格子和版式不用动，测试里固定了这一点。
- 项目栏写「分类（月份）」（Task 11 的 `formGroupLabel`，如「电费（2026年7月）」「空调能源费（2026年10月）（续）」）。项目栏内宽约 134pt，10pt 放不下就逐级缩小：10 → 9 → 8 → 7 → 6.5pt（一个全角字和字号一样宽，各档分别放 13、14、16、19、20 个字），缩小后仍在本行上下居中；6.5pt 还放不下报 `FORM_TEXT_OVERFLOW`。金额栏的数字固定 10pt。

**备注栏写收款方**
- 内容：这张单上用到的收款方，按出现的先后；户名、开户银行、银行账号三项都一样的只写一次（同名不同账号、同名同账号不同银行、同账号不同户名都算两家）；每家最多三行（「收款户名：…」「开户银行：…」「银行账号：…」），没有的项不写，没有收款方的凭证不写；账号原样写，不分组、不加空格（要和回单、网银对得上）；收款方之后空一行，再写所选的备注。
- 字号：先 10pt（行距 4）；放不下依次缩到 9pt/行距 3.5、8pt/3、7pt/2.5、6.5pt/2（备注栏内宽约 162.5pt、内高约 104.4pt，各档放 5、6、7、8、9 行；名字太长会折成两行，占的行数就多）。同一个字号里先试「各家之间空一行」，放不下再试「不空行」，还不行才缩到下一个字号。例：示例里第 1 张单的两家收款方 → 8pt、各家之间空一行；第 2 张单（通知单的一家）→ 10pt。
- 6.5pt 的紧凑写法也放不下（家数多）：第一页用 6.5pt 写放得下的前几家，末尾另起一行写「（接续页）」，其余接到「备注续页」（10pt，行距 4）。断口只落在家与家之间（一家的几行、一个银行账号不会拆到两页；没有空行可退时落在行与行之间；第一行就放不下才按字断），每页开头结尾不留空行。「单据及附件共 N 页」把续页算进去。
- 店内的备注不变：只有所选的备注，一直 10pt，放不下仍按字断、「（接续页）」接在最后一个字后面。

**设置和附件页**
- `Settings.companyDepartment`（可选，≤100 字，老版本网页不带这个键也能保存，带了必须是字符串）；`resolveOptions(settings, now, ledger = 'store')`：公账取 `companyDepartment`（没设置就留空，打印后手写，不拿店内的部门顶替），店内仍取 `department`。
- `formNameOf(ledger)`：店内「报销单」，公账「付款单」；`receiptCaption` 多可选的 `ledger`；附件页页眉写「第 N 张付款单 · …」（多项凭证的说明 `linesCaption` 不给区时按公账写）。

**测试**
- 新增 `apps/api/test/company-form.test.ts`（61 例）：单据上的字（公账、店内、字数）；设置的各种输入；备注栏的收款方（顺序、去重和三种「不算重复」、缺项、没有收款方、店内不打印、空行规则）；五档字号的字号和行距逐档量过；项目栏缩字号的每一档、居中、放不下；备注续页（整家整家、10pt、一字不少、页数）；店内备注的按字断和上下居中；整份 PDF 的页数、页眉、附件页；`snapToLine`、`layoutNote` 的直接测试。更新了 `company-lines.test.ts`（4 处）、`attachments.test.ts`（2 处）里的「报销单」字样；contracts 61 → 62（`formNameOf`、`receiptCaption`）。
- 店内字节比对：临时留了一份改之前的 `form.ts`，对 10 种店内情形（无备注、短备注、两行、含空行、折行、单段超长、多段超长、一段中间断开、尾部带换行、多分类多页）生成 PDF，逐字节一致；比对完删除，没有进仓库。
- 看过真实生成的 PDF（示例的两张单、两家带备注、三家、五家加续页、超长名字、长项目名）：标题、标签、表格、备注栏对齐正常。
- 故意改坏 107 处（字样、区的开关、项目栏每一档字号、备注栏每一档字号和行距、断行规则、分页、收款方去重和各行、设置校验、附件页页眉、契约的叫法）：第一轮 84 处被抓到，23 处没抓到；补测试后其中 20 处被抓到；剩下 3 处不补：两处写法等价（`snapToLine` 里找空行的起点，前面已经处理了跨在断口上的空行），一处是备注接续页给「（接续页）」多留的 4pt 余量（只影响第一页多放或少放一行，不影响正确性）。
- 全部测试：contracts 62、api 606、web 193 通过；api 和 web 类型检查通过。

**留意（Task 13 要接上）**
- 网页生成批次时的选项是网页自己算的（`formOptionsFromSettings`），不走服务器的 `resolveOptions`：公账批次要用 `companyDepartment` 当付款单位；设置页要加「公账付款单位」输入框，保存时带 `companyDepartment`。
- 预览页和对账页的字样：`PdfPreview` 用「张报销单」识别凭证附件页，要改成「张报销单」或「张付款单」都认（否则公账的附件页会被当成单据页画出来）；对账页的「第 N 张报销单」标题、预览页的「报销部门」「报销人」标签、404 和内存不足的提示也要按区换。
- 一张单上收款方家数多时导出的 PDF 会多出备注续页，「单据及附件共」已把续页算进去；预览页要能翻到续页（和店内备注续页一样处理）。
- 付款单上的银行账号来自 AI 读图，位数可能读错：付款前要在对账页对着原图核对（Task 13 把收款方放在凭证图旁边）。

## 公账付款区 Task 13 — 前端（Claude，2026-10-01，基于 43d0074；方案见 `company-ledger-plan.md`）

做了什么：网页上有了「公账付款」区：头部切换、公账自己的地址和导航、六个页面（上传回单、本期付款池、待处理、付款单预览、历史付款单、设置）、编辑框里的收款方、费用月份和多项明细、对账页里的多项凭证和收款方。店内区的页面、地址、文字一个字没变（店内原有的测试原样通过，只给 `PdfPreview`、`SettingsPage` 等加了区的参数和默认值）。端到端脚本和示例图片已写好，但还没跑，留给第 14 步。

**区域切换和地址**（`routes.ts`、`App.tsx`）
- 头部左边是「店内报销 | 公账付款」切换（`aria-label="切换区域"`），公账区整个头部带绿色上沿和绿色当前项，不会看错在哪个区；导航栏店内是「首页、上传凭证、本期报销池、待处理、生成预览、历史报销单、设置」，公账是「上传回单、本期付款池、待处理、付款单预览、历史付款单、设置」（没有首页）。手机上导航横向滚动，和店内一样。
- 店内地址不变（`#pool`、`#preview`、`#batches/xxx/preview`……）；公账是 `#company`（等于上传）、`#company/<页面>`、`#company/batches/<批次>/preview`。`parseRoute`、`routeHash`、`switchLedgerHash` 是不碰浏览器的纯函数，单独测。
- 切换区时停在同一页（设置到公账设置，池到公账池……）；店内「首页」到公账是「上传回单」；带批次号的预览是上一个区的批次，到另一个区只去它自己的「预览」页，落到那个区最近的草稿。
- 每个区各记各的当前批次（取消批次后忘掉），切区时整个页面区重新挂载（`ErrorBoundary key={ledger}`），一个区的草稿、报错不会带到另一个区。

**取数和文字**
- `ledgerApi.ts` 的 `apiFor(ledger)`：店内就是原来的 `api`（调用写法和断言的参数一个字没变）；公账是同一个 `api` 外面包一层，上传、凭证列表、汇总、历史、归档、取消归档、清理这几个自动带 `ledger=company`；规则、重新套用规则由设置页自己把区当参数传。
- `wording.ts` 的 `sayFor(ledger)`：页面里写的都是店内原话，公账区把词换掉：报销人/签名人 → 经办人，报销 → 付款（报销池、报销单、可报销一并），凭证 → 回单，部门 → 付款单位；整句另有「生成预览 → 付款单预览」「完整报销 PDF 预览 → 完整付款单 PDF 预览」。只给页面里写死的文字用，用户输入的内容（商户、户名、备注）不套。
- 页面都接受 `ledger`：上传页（回单说法，写明收费通知单会按项目拆成几行、收款方写进备注栏；另一个区已有同一张图时说「已在「店内报销」里」，不只写「重复」）、待付款池（八个分类的汇总，明细凭证按各项分到各分类）、待处理（含「各项加起来和合计对不上」等原因）、预览页（付款单位、经办人，付款单位默认取设置里的公账付款单位）、历史（公账批次的原图叫回单，没有退款图）、设置页。

**编辑框、卡片、对账页**
- `CompanyReceiptEditor`（`ReceiptEditor` 按凭证所在的区选用它或原来的店内编辑框）：日期、付款金额（认千分位和全角）、分类（公账八类）、费用月份（选填）；「拆成多项」后每项一行（分类、月份、金额，可删、可再加一项、可合回一项），下面实时显示合计，AI 读到的合计和各项之和对不上时提醒；收款方三项（户名、开户银行、银行账号，账号下写着「账号有十几位，请对着图逐位核对，一位都不能错」）；确认可付款、删除回单。提交前按后台同样的规则先检查（至少 2 项、分类加月份不重复、金额大于 0、月份写法、账号位数）。检查和换算都在纯函数 `companyEditing.ts` 里。
- 月份用 `type="month"`：Chrome 和 iPhone 有选择器，Mac 上的 Safari 没有，会显示成普通文本框，所以加了「例如 2026-07」的提示，手写「2026-07」「2026年7月」「2026/7」都认。
- 卡片（`ReceiptCard`）：公账凭证显示各项（分类（月份） 金额）和收款方三行（`payee.ts` 的 `payeeRows`，缺的项不显示）。
- 对账页（`ReconcileWorkspace`）：一张通知单出现在几行下，各行下各有自己的金额，点哪个都是同一张图；点金额会滚到那一张单、那一页；凭证图旁边显示收款方，要求对着图核对；图片加载慢时用「回单」的说法提示并给重试；手机上三个标签是「回单 | 清单 | 付款单」。
- `PdfPreview` 的附件页识别改成「张报销单」「张付款单」都认（页脚有「单据及附件共」的一定是单据页，不会因为备注里碰巧写了「第 2 张付款单」「原始凭证」被跳过），加载、画图、网络慢的提示按区换说法。
- 规则编辑（`RulesEditor`）：公账只列公账八类。

**顺手修了**
- 设置页保存后原来没有任何提示（状态存了但没画出来），现在显示「设置已保存」；之后再保存失败会清掉旧的成功提示、换成错误（店内也一样）。
- 设置页加「公账付款单位」（公账区）；两个区共用的日期、签名人（公账区叫经办人）、识别阈值和备注模板，页面上写明是共用的。
- 完整预览的名字：换词会变成「完整付款 PDF 预览」读起来不通，整句改成「完整付款单 PDF 预览」。
- `linesCaption`（通知单在一张单上的对账说明）和 `SheetRow` 从 `render/attachments.ts` 挪到契约里，PDF 附件页页眉和网页对账区共用一个写法；`attachments.ts` 仍然导出它们，原来的引用和测试不用改。

**测试**
- 前端新增 17 个测试文件（共约 370 例）：`routes`、`ledgerApi`、`wording`、`payee`、`companyEditing`；组件和页面各一份「公账」测试（上传、待付款池、待处理、预览、历史、设置、规则编辑、编辑框、卡片、对账页、PDF 预览）；`App.company.test.tsx`（头部、地址到页面和区、各种切换、同区不重复跳转、切区重新挂载、预览入口的草稿、找不到草稿时的说明、各区记住各自批次、取消后忘掉）。每个页面都成对测：公账是新说法、店内还是原来的说法。
- 故意改坏前端约 240 处（路由换算、取数带不带区、换词表、各页面的文字和接口、编辑检查、明细合计、对账页金额和滚动、PDF 附件页识别……）：第一轮 17 处没被抓到——其中 11 处是真漏洞（切区后设置页没重新取规则、回收站恢复后的提示、PDF 预览的附件页判断和三种状态文字、对账页的分摊金额和滚动、收款方空串、换词只换第一处、签名人一词没覆盖……），补测试后全部抓到；3 处是换词表里多余的词条（「报销池」「报销单」「可报销」都被「报销」一条覆盖了），删掉；3 处写法等价不补（编辑框初始金额不看退款，因为公账没有退款；预览页店内行取自哪个函数结果相同；给没有可换词的句子套 `say` 前后一样）。之后又发现并修了设置页的「签名人」在公账区没换成「经办人」，加了测试并改坏验证。
- 全部测试：contracts 67、api 606、web 566 通过；api、web、contracts 类型检查通过；`pnpm --filter web build` 通过。
- 版面：用 Chromium 在 375、768、1024、1366 宽度看头部（店内和公账），1100 宽看付款池、通知单和肉款回单的编辑框，1280 和 390 宽看对账预览（桌面和手机，回单和清单两个标签），手机宽度看设置页；没有重叠和溢出，截图里的月份输入框是英文显示，是因为无头浏览器的语言是英文，真机上跟随系统。

**留意**
- 端到端（上传两张回单加一张通知单 → 付款池 → 生成付款单 → 预览 → 导出 → 历史，店内同时有凭证、两边互不出现）脚本和示例图片已写好，没跑，第 14 步跑、修，再用 Safari 26 的方式（`pretendToBeSafari`）看一遍公账预览。
- 第一次用：到公账区设置里填「公账付款单位」，加两条固定规则（例如「新沣」→ 肉款、「品牌管理」→ 品牌管理费），回单就不用每次靠 AI 判断分类；银行账号是 AI 读图读出来的，付款前要在对账页对着原图逐位核对。
- 真实的 DeepSeek 对银行回单和收费通知单的识别还没有实测。
