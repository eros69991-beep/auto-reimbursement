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
