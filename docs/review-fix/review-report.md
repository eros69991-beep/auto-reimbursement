# 自动报销助手（Auto Reimbursement Assistant）只读审查报告

- **审查对象**：`eros69991-beep/auto-reimbursement`，分支 `feature/mvp-implementation`，HEAD `2df0973`（2026-09-27 02:00 +0800）
- **审查日期**：2026-09-27
- **审查方式**：只读。未修改、新增、删除仓库内任何受版本控制的文件；复现脚本、临时数据库、合成凭证图和截图全部放在仓库之外的临时目录；审查结束时 `git status` 为空。未读取或输出任何密钥。
- **环境**：Node 24.21.0、pnpm 11.19.0、Playwright 1.63（`channel: 'chrome'` 实际指向本机 Chromium 141）
- **证据截图**：与本报告同目录的 `review-evidence/`（E1–E6，均为合成数据，不含真实凭证）

> **一句话结论**：工程底子不错，但目前**不适合承载真实财务数据**。API 和前端**完全没有鉴权**，拿到网址的人都能看、改、删全部数据。另外有 3 个核心流程上的致命缺陷，都已在本地复现：同一分类超过 10 张就生不成报销单；先录退款再改低金额会让报销池整页白屏；商户名超过 24 个字会让整批 PDF 报 500。进入真实月度使用前，请先完成第 4 节 Top 10 里的前 5 项。

---

## 1. 只读验证结果

| 命令 / 动作 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，锁文件未变，供应链策略检查通过（392 个依赖） |
| `pnpm test` | **有条件通过**：**256 个用例全部断言通过**（contracts 25 / api 192 / web 39）。但 web 包 4 次运行里有 2 次以**退出码 1** 结束，原因是 `src/App.test.tsx` 触发了 2 个 “Unhandled Errors: window is not defined”。结果不稳定，详见 P-29 |
| `pnpm typecheck` | 通过：3 个包（注意：`e2e/` 不在类型检查范围内，其中存在 TS2741，详见 P-30） |
| `pnpm audit` | 2 个 moderate：`vitest` 和 `@vitest/mocker`，GHSA-82fw-gwwq-j7x9，仅影响开发依赖；无 high/critical |
| `pnpm --filter @auto-reimbursement/web build` | 通过：主包 234.6 KB（gzip 73 KB）；`pdf-*.js` 437.7 KB 和 `pdf.worker.min.mjs` 1.27 MB **已按需懒加载**，只在预览页请求 |
| `pnpm test:e2e` | 通过：9/9。直接使用仓库里已提交的 fixtures，**没有运行 `pnpm fixtures`**，以免改写仓库文件 |
| 前端产物 / git 历史密钥扫描 | 通过：构建产物中未发现 `sk-`、`AI_API_KEY`、`Bearer`、数据库连接串等特征。git 全历史里只提交过 `.env.example`，从未提交过 `.env`。历史中 `AI_API_KEY=` 出现 3 次，都在文档 `docs/superpowers/plans/2026-09-14-hosted-deployment.md` 中，值长度为 1，属于占位，不是密钥 |
| 线上只读验证（`/health`、首页） | **未执行**。本审查沙箱的出口代理对 `*.up.railway.app` 和 `zidongbx.netlify.app` 返回 403（策略拒绝），按规定没有绕行。可自行执行的只读命令见附录 B |
| 本地真实浏览器走查 | 用仓库自身的 API 模块，在临时目录中配合一个“假 AI 分析器”启动后端（无网络、无密钥）。用 `vite preview` 运行生产构建，上传 23 张合成的 12MP 凭证图（约 2 MB/张）。再用 Playwright 在 1366×768、768×1024、375×812 三种视口截图、测量，并逐项复现问题 |

---

## 2. 已知历史问题复核（对应任务说明第 6 节）

| # | 声称已修复的问题 | 复核结论 | 对应问题 |
| --- | --- | --- | --- |
| 1 | 切换页面时布局边界不稳，设置页跑出界面 | **未彻底修复**。视口宽度在 609–870px 之间时（iPad 竖屏 768/810/820/834、手机横屏 844/852 都在此区间），导航里的「设置」会被裁到屏幕外，而且无法滚动过去；609–700px 时连「历史报销单」甚至「生成预览」也够不到。桌面端带经典滚动条时，页面在“有/无纵向滚动条”之间切换，内容会左右跳 7.5px；预览页在宽度 ≥900px 时还会切换成全宽 | P-14 |
| 2 | 报销单版式与纸质样本不一致 | **部分修复**。线框、列宽、金额九位格已基本对齐样本。但「金额（大写）」栏填的是**阿拉伯数字**；同一分类有多张凭证时，**表格行线会穿过摘要和金额文字**；标题下划线压到了字 | P-06、P-07、P-36 |
| 3 | 报销单预览只能看到一半，需要横向滑动 | **部分修复**。在支持新 JS API 的浏览器上已修复：375px 下画布 359px 适宽，无横滑（注入 polyfill 后验证）。但 `pdfjs-dist` 6.x 的现代构建依赖 `Map.prototype.getOrInsertComputed`，在 Chrome < 145、iOS Safari < 26.2、三星浏览器以及多数国产 / 微信内置内核上，**预览会整块失败**，只显示“预览加载失败” | P-08 |
| 4 | 部门、备注、报销人字段无法编辑保存 | **部分修复**。显式点击「保存预览设置」后能持久化，刷新可恢复（已验证）。但如果**没点保存就点「生成 PDF」**，系统会按服务器上的旧值定稿并锁定，输入框被清空；点分类的「上一页/下一页」同样会冲掉未保存的输入。用户仍会遇到“填了保存不上” | P-05 |
| 5 | 删除凭证后批次不可恢复 | **核心已修复**。软删除/恢复、撤销批次退回报销池、作废 PDF 留存都可用。遗留的小问题：恢复后列表不刷新；已删除的凭证重新上传会被判为“重复”；撤销后重建批次，批次内的手写备注会丢失 | P-31、P-32、P-33 |

---

## 3. 问题清单（5.1）

> 编号按严重级别排列（Blocker → Major → Minor → Nit）。【】内是维度：A 实用性 / B UI·UX / C 前端代码 / D 后端 / E 安全 / F 测试与可维护性 / G 部署运维。
> “已复现”表示在本地用生产构建和真实浏览器（或 API）实际跑通；未标注的是代码走查结论。

### Blocker

[P-01] 【E 安全】API 与前端完全没有访问控制：任何人都能读取、篡改、永久删除全部财务数据
- 严重级别：Blocker
- 现象：
  - 整个 `/api` 路由没有任何鉴权中间件（`apps/api/src/app.ts:58`）。唯一的防护是跨源修改拦截：只有请求**带 `Origin` 头且不在白名单**时才返回 403（`app.ts:45`）。curl、脚本、服务器之间的调用不带 `Origin`，可以直接放行。已本地复现：不带 Origin 的 `POST /api/cleanup/2026-09` 能进入业务逻辑，带恶意 Origin 的才会 403。
  - 可被匿名调用的高危接口包括：
    - `GET /api/receipts`、`/api/images/:id`：全部凭证与原图。
    - `GET /api/backups/:id`：整库 SQLite 备份。
    - `POST /api/cleanup/:month`：永久删除当月原图。确认口令 `DELETE ORIGINALS <月份>` 写在公开仓库里（`routes.ts:106-112`、`archive.ts:44`）。
    - `DELETE /api/receipts/:id`、`PUT /api/settings`、`PUT/DELETE /api/rules/:id`。
    - `POST /api/receipts/upload`：每次最多 50 张 × 20 MB，全部进内存，并且会**消耗 AI 额度**。
  - 前端（Netlify）也没有登录。API 域名在构建时写进了公开的 JS（`VITE_API_BASE_URL`），所以 README 里“不要公开分享 Railway 域名”（`README.md:165-167`）这条防护**实际不成立**。
  - 错误文案“拒绝非本机来源的修改请求”（`app.ts:191`）说明整套防护是按“只在本机运行”的威胁模型设计的，迁到公网后没有补上鉴权。
- 影响：凭证图片、金额、商户、签名图都是敏感财务数据，可能被任何人读取或下载整库备份。有人恶意删除或篡改时，没有日志、没有操作者记录，无法追溯。有人刷上传会产生 AI 费用，还可能把后端内存打爆（OOM）。
- 解决方案（按成本从低到高）：
  1. **当天**：确认线上是否已有真实数据。如果有，在加鉴权之前暂时移除 Railway 公网域名或停掉服务，或只放脱敏测试数据。
  2. **最低成本的鉴权（约 1 天）**：
     - 后端：在 `app.ts` 挂载 `/api` 之前加一个 `requireAccess` 中间件，校验 `Authorization: Bearer <访问码>`。服务端只存访问码的 SHA-256（环境变量 `ACCESS_CODE_SHA256`），用 `crypto.timingSafeEqual` 比较。`/health` 除外。
     - 前端：`apps/web/src/api.ts` 的 `requestJson` 统一带上这个头；新增一个访问码输入页，收到 401 时回到该页。
     - 图片和 PDF 不能靠 `<img src>` 直接传请求头：图片改为 `fetch` + `URL.createObjectURL`；pdf.js 用 `getDocument({ url, httpHeaders })`；下载也改成 blob 方式。
     - 同时加上 `express-rate-limit`（上传、备份、清理这几类接口从严限流）和 `helmet`。
     - 鉴权上线后更换一次 Railway 域名。
  3. **不改代码的替代方案**：给前后端都绑自有域名，前面挂 Cloudflare Access / Zero Trust。
  4. **中期**：多人使用时引入账号体系和审计日志（见 P-34）。
- 工作量估计：M

[P-02] 【A 实用性】同一分类超过 10 张凭证就无法生成报销单（已复现）
- 严重级别：Blocker
- 现象：
  - 在报销池勾选 11 张「食材」后点「生成报销单」，API 返回 `400 {"code":"CATEGORY_TOO_LARGE","message":"请求参数无效"}`，页面上只显示“请求参数无效”。10 张可以生成，11 张就失败。
  - 根因：版式把每张凭证画成单独一行，行高 14pt（`apps/api/src/render/form.ts:78-79`），分组高度按凭证数计算（`apps/api/src/render/layout.ts:63-69`）。而 5 行表体总高只有 156.5pt，一个分类最多放下 10 张。`packGroups` 只能整类移动，不能拆到下一页（`layout.ts:71-90`、`139-149`）。
- 影响：餐饮店一个月的食材票据通常远超 10 张，按月报销的主流程直接走不通。用户也不知道原因，只能凭猜测拆成多批。
- 解决方案：
  - **推荐**：回到原计划的“汇总明细行”语义（`docs/reimbursement-fix/plan.md` Task 04：“超过 5 个汇总明细行按 5 行分页”）。每个分类在表格里只占一行，摘要写「共 N 张，明细见附件」或列出前几个商户加“等”，金额填分类合计，逐张明细放到附件页或新增的「明细清单」页。改动涉及 `layout.ts` 的 `groupHeight`/`packGroups`、`form.ts` 的 `drawGroups`（260 行起），以及 `layout.test.ts` 和 `form.test.ts`。
  - 这个方案同时解决 P-07 的行线压字，也能缓解 P-04。
  - 如果坚持逐张列出，就要允许一个分类跨页续排（标注“续”），并保证每张的小计和总计一致。
  - `routes.ts:720-736` 需要把 `CATEGORY_TOO_LARGE` 翻译成具体提示，例如“「食材」共 12 张，超过单张报销单容量，已自动分页/请分批”。
- 工作量估计：M

[P-03] 【A 实用性 / C 前端】先录退款再调低实付金额，报销池整页白屏，刷新也无法恢复（已复现，见 E1）
- 严重级别：Blocker
- 现象：一张 197.07 元的凭证，先保存退款 150.00，再把实付改为 100.00 并点「确认可报销」：
  1. 服务端照单全收，得到 `status=ready, paidFen=10000, refundFen=15000`。`updateReceipt` 和 `confirmReceipt` 都没有校验“退款 ≤ 实付”（`apps/api/src/receipts.ts:134-160`、`162-189`）。
  2. `netFen()` 遇到退款大于实付会直接抛出 `INVALID_REFUND`（`packages/contracts/src/index.ts:263-278`）。
  3. 前端 `ReceiptCard.tsx:6` 和 `PoolPage.tsx:7-9` 在渲染时调用 `netFen`，抛错后整个 React 树卸载，整页白屏；应用里也没有 Error Boundary。
  4. `GET /api/pool/totals` 返回 500（`batches.ts:27-43` 内部走 `refunds.ts:73-84` 的 `isEligible`）。
  5. 刷新 `#pool` 依旧白屏。本次复现最后只能用 API（`PUT /refund` 设为 0）把数据修回来。
- 影响：核心的「报销池 → 生成报销单」页面被一条数据永久打挂，普通用户在界面里没有任何办法恢复。
- 解决方案：
  - 后端：`updateReceipt` 在新金额小于 `refundFen` 时拒绝，返回明确的错误码（如 `REFUND_EXCEEDS_PAID`），`confirmReceipt` 也做同样校验。`isEligible`/`poolTotals` 改成防御式写法：单条数据异常时视为不可报销并记录日志，不能拖垮整个接口。另写一次性脚本，排查存量里退款大于实付的数据。
  - 前端：`ReceiptEditor` 提交前校验金额不低于已退款；卡片使用不抛异常的净额计算，异常数据显示“退款大于实付，请修正”；`App.tsx` 给页面加 Error Boundary，提供“返回/重试”。
  - 补充 API、组件和 e2e 回归测试。
- 工作量估计：S

[P-04] 【D 后端 / A 实用性】商户名超过 24 个汉字，整批预览和导出都返回 500，用户无法自行修复（已复现）
- 严重级别：Blocker
- 现象：
  - 摘要栏宽 245.4pt，10pt 字号下最多放 24 个汉字。超出时 `drawGroups` 直接抛出 `FORM_TEXT_OVERFLOW`（`form.ts:281`，`assertFits`），不会缩字号或截断。
  - `batchHttpError` 没有映射这个错误码（`routes.ts:690-738`），最终返回 `500 服务器内部错误`，而且没有日志（P-17）。
  - 本地用 27 字商户“深圳市百慕达国际海鲜餐饮管理有限公司远洋分店酒水专柜”复现：`preview.pdf` 返回 500，`export` 返回 500。页面提示“预览加载失败，请使用下方链接打开或下载 PDF”，可下方链接指向的同一个接口也报错。
  - 商户名来自 AI 识别，校验允许最多 200 字（`ai/validate.ts`），而前端不能改商户（P-11）。正式发票的销售方全称超过 24 字很常见。
- 影响：含这类凭证的批次无法预览，也无法导出。用户只能撤销后把这张票剔除，这张票就永远无法通过系统报销。
- 解决方案：
  - 摘要栏复用 `drawFittedText`：字号从 10pt 逐级降到 7pt，仍放不下就截断加“…”，完整商户名保留在附件页标题。
  - 允许用户修改商户（见 P-11）。
  - 所有渲染异常都映射成可读的 4xx，指出是哪张凭证，并记录日志。
  - 建批时预检一次版式，提前暴露问题。
- 工作量估计：S

### Major

[P-05] 【B UI/UX】未保存的部门/报销人会被「生成 PDF」和「上一页/下一页」吞掉，而且批次随即被锁定（历史问题 4 未彻底修复；已复现，见 E5）
- 严重级别：Major
- 现象：
  - 预览页修改的部门、日期、报销人只存在前端本地 state，只有点「保存预览设置」才会提交（`apps/web/src/pages/PreviewPage.tsx:166-236`）。
  - 「生成 PDF」直接调用 `exportBatch`，不会先保存（`PreviewPage.tsx:56-66`）。服务器按旧快照定稿，返回的旧值覆盖了输入框。复现结果：部门输入“远洋店-财务部（未点保存）”后点「生成 PDF」，服务器定稿的 `department` 为空，输入框被清空并变成只读；再调用 `PATCH options` 返回 `409 BATCH_FINALIZED`。
  - 分类「上一页/下一页」用服务器返回的 batch 整体覆盖本地 state（`PreviewPage.tsx:43-54`），未保存的部门和报销人被还原为空，已复现。
  - 页面没有“有未保存修改”的提示，保存成功后也没有明确反馈；「生成 PDF」实际上就是“定稿”，点击前也没有二次确认。
- 影响：用户体验和原先投诉的“字段保存不上”完全一样。补救办法只有撤销、回到报销池重选、重新填写，批次内的手写备注也会随之丢失（P-33）。
- 解决方案：
  - 给 `PreviewPage` 增加 dirty 状态（对比本地与最近一次保存的 options/noteBySheet）。
  - `exportCurrent`：有未保存修改时先 `await saveBatchOptions` 再导出，或者直接禁用导出并提示；导出前弹确认框，写明“生成后将锁定：部门 X、报销人 Y、日期 Z”。
  - `move()` 合并服务器返回的 `sheets` 和本地未保存的 `options`，做法和 Task 07 修 notes 时一样。
  - 保存成功显示“已保存”，离开页面时提示有未保存修改。
  - 在 `PreviewPage.test.tsx` 和 e2e 中补上“未保存直接生成”的用例。
- 工作量估计：S

[P-06] 【B UI/UX】报销单「金额（大写）」栏填的是阿拉伯数字，已写好的大写转换函数从未被调用（已复现，见 E3/E4）
- 严重级别：Major
- 现象：
  - `drawUppercase` 在「佰 拾 万 仟 佰 拾 元 角 分」各格里填的是阿拉伯数字（`apps/api/src/render/form.ts:316-341`，331 行 `[...digits].forEach(...)`）。`pdftotext` 抽取 10 张食材批次的结果为 `(大写) 1 1 0 1 6 5`。
  - `apps/api/src/uppercase.ts:22` 的 `chineseUppercase()` 带有完整单测，但在整个 `src` 中**没有任何调用**。
- 影响：大写金额栏本来是防篡改用的，填阿拉伯数字不符合财务票据惯例，财务可能退单。相关单测给人“大写已实现”的错觉。
- 解决方案：各单位格改填“零壹贰叁肆伍陆柒捌玖”对应字，首位之前的空位按财务要求留空或画“⊗”；也可以在该栏直接写整串大写，例如“壹仟壹佰零壹元陆角伍分”。具体写法请先和财务确认。在 `form.test.ts` 中用 pdf.js 抽取文本，断言大写内容。
- 工作量估计：S

[P-07] 【B UI/UX】同一分类多张凭证时，打印出来的表格行线穿过摘要和金额文字（已复现，见 E4）
- 严重级别：Major
- 现象：每张凭证按 14pt 逐行排版（`form.ts:278-281`），而纸面 5 行每行 31.3pt，行线按固定行距绘制（`form.ts:233`），两者不对齐。10 张食材批次中，“农贸市场张记”“美团买菜”“叮咚买菜”这几行的文字和金额数字被横线穿过。
- 影响：打印件上的金额看起来像被划线作废，可读性和合规性都会受质疑。“1:1 还原样本”在有多张凭证时并不成立。
- 解决方案：与 P-02 一并处理，改为每个分类一行的汇总版式，文字不再跨越行线。如果保留逐张列出，行内文本要按 `rowHeight / 每行张数` 垂直居中，行线只画在分组之间。增加渲染回归测试：用 pdftoppm 或 pdf.js 出图，和基准图做容差比对。
- 工作量估计：M（与 P-02 合并做）

[P-08] 【B UI/UX / C 前端】PDF 预览在大量手机浏览器上整块失败（历史问题 3 的修复引入了兼容性回退；已复现）
- 严重级别：Major
- 现象：
  - `PdfPreview.tsx:20-21` 引入的是 `pdfjs-dist` 6.3.289 的**现代构建**。这个构建在主线程和 worker 中共 33 处调用 `Map.prototype.getOrInsertComputed`。
  - 在 Chromium 141 上，预览抛出 `TypeError: this[#e].getOrInsertComputed is not a function`。这个异常被 `catch {}` 吞掉（`PdfPreview.tsx:49`），用户只看到“预览加载失败”。
  - 按 caniuse，该 API 只有 Chrome/Edge 145+、Firefox 144+、Safari/iOS Safari 26.2+ 支持，三星浏览器不支持。国内常见的微信 XWeb、X5 和各厂商浏览器内核版本通常更旧。
  - `pdfjs-dist` 包内自带 `legacy/` 构建，里面已包含这个 polyfill。注入 polyfill 后，375px 下预览正常且适宽（画布 359px，无横滑）。
- 影响：手机是主要使用场景，一部分用户的「同屏对账」左半边会一直失败，而开发者用最新版 Chrome 测不出来。
- 解决方案：
  - 改为 `import('pdfjs-dist/legacy/build/pdf.mjs')`，worker 也换成 `legacy/build/pdf.worker.min.mjs?url`。
  - `catch` 中至少 `console.error` 并上报。
  - 在项目里定义 browserslist，e2e 增加一个旧内核冒烟用例（例如用 Playwright 的 WebKit，或固定一个旧版 Chromium）。
  - 更稳妥的做法是由服务端把表单页渲染成 PNG 用于预览（`pdftoppm` 或 sharp），手机端完全不依赖 pdf.js。
- 工作量估计：S

[P-09] 【G 部署运维】数据实际存在 Railway 卷上的 SQLite，并不在 Neon；备份和数据在同一个卷上，没有异地备份和恢复演练，健康检查也不校验卷
- 严重级别：Major（如果 Railway 实际没挂 Volume，则升级为 Blocker：每次重新部署都会静默清空全部数据）
- 现象：
  - 代码只使用 `node:sqlite`（`apps/api/src/db.ts:3`），库文件是 `DATA_DIR/app.sqlite`（`config.ts:82`），依赖里没有任何 Postgres 或 Neon 驱动。任务说明中“Postgres（Neon）”的描述与实际不符。凭证原图、退款图、签名和导出的 PDF 也都在 `DATA_DIR` 下（`README.md:76-89`）。
  - 设置页的“备份”只打包数据库，不含图片，而且备份文件写在同一个卷的 `backups/` 里，永不清理（`apps/api/src/backup.ts:10-43`）。
  - 没有恢复工具，也没有恢复文档或演练记录（README 只写了“先停 API 再复制”）。
  - `/health` 恒定返回 200（`app.ts:53-55`）。卷没挂上时，`mkdirSync` 会在容器临时盘上建目录，照常运行，重启后数据全部丢失，健康检查却全程是绿的。
- 影响：卷损坏、误删服务、平台故障或配置错误都可能让全部报销记录和原始凭证一起丢失，而且没有第二份。
- 解决方案：
  1. **当天**：
     - 在 Railway → 服务 → Volumes 确认 `/app/data` 已挂载。
     - 按 README 第 10 步做一次“上传测试凭证 → 重新部署 → 确认数据仍在”。
     - 手动下载一份完整的卷快照。
  2. **启动自检**：在 `server.ts` 中，当 `REQUIRE_VOLUME=1` 且标记文件 `/app/data/.volume-id` 不存在时拒绝启动。`/health` 增加 `SELECT 1` 和 `DATA_DIR` 可写性检查，失败时返回 503。
  3. **异地备份**：
     - 用 Litestream 把 `app.sqlite` 持续复制到 S3、Cloudflare R2 或阿里云 OSS。
     - 每晚用 rclone 同步 `*/originals|refunds|exports` 到对象存储，并设置保留策略。
     - 或者把图片直接改存对象存储。
  4. **恢复演练**：写一份恢复手册，每季度在新卷上演练一次恢复。
  5. **Neon**：明确处理。要么从架构文档中删掉并停用（避免“以为有托管备份”），要么规划迁移到 Postgres（L）。
- 工作量估计：M

[P-10] 【A 实用性】编辑凭证后“确认”一步失败，这张凭证会从所有页面消失（已复现）
- 严重级别：Major
- 现象：
  - 「确认可报销」分两次请求：先 `PATCH`，再 `confirm`（`apps/web/src/components/ReceiptEditor.tsx:36`、`47`）。`PATCH` 会把状态置为 `pending`，但保留原来的 `pendingReasons`（`receipts.ts:155`）。池中凭证原本没有 reasons，改完就变成 `pending` 且 reasons 为 `[]`。
  - 报销池只显示 `ready`（`receipts.ts:203-205`），待处理页又过滤掉 reasons 为空的记录（`apps/web/src/pages/PendingPage.tsx:23`）。
  - 复现：拦截 confirm 请求模拟断网，页面提示“修改已保存，但确认可报销失败：Failed to fetch”。刷新后报销池和待处理页里都找不到这张票，API 中它仍是 `status=pending, reasons=[]`。
- 影响：凭证“失踪”，容易漏报。由于 `archiveMonth` 要求当月没有 pending（`archive.ts:14-17`），**当月也无法归档**，而用户根本不知道卡在哪一张。
- 解决方案：
  - 合并成一个原子接口，例如 `POST /api/receipts/:id/confirm` 携带 `{ paidFen, category, merchant?, date? }`，在同一个事务里完成修改和确认。
  - 或者对 `ready` 凭证的修改保持 `ready`（字段校验通过即可），不降级。
  - 待处理页显示所有 pending，reasons 为空的标记为“修改待确认”。
  - 写一次性脚本，查出存量里 reasons 为空的 pending 记录。
- 工作量估计：S

[P-11] 【A 实用性】识别错误的日期和商户（报销单上的“摘要”）无法修改
- 严重级别：Major
- 现象：`PATCH /api/receipts/:id` 只接受 `paidFen` 和 `category`（`routes.ts:600-615`、`receipts.ts:134-160`），编辑器里也只有这两个输入框（`ReceiptEditor.tsx:107-120`）。商户会原样打印在报销单摘要栏，日期参与疑似重复判断。学习模块优先使用 AI 识别的商户（`learning.ts:96-107`），用户也无法纠正。
- 影响：AI 认错商户时，错误会被印到正式报销单上，还会连带触发 P-04 的 500。日期错误会影响查重和对账。
- 解决方案：
  - PATCH 增加 `merchant`（去空格，≤50 字）和 `date`（`YYYY-MM-DD`，做日历校验），编辑器增加对应输入框，日期用 `type="date"`。
  - `featureFor` 改为优先使用用户修正后的 `receipt.merchant`。
  - 建批快照使用修正后的值，并补测试。
- 工作量估计：M

[P-12] 【A 实用性 / C 前端】上传链路在弱网下不可靠：一次性单请求、没有进度、单个文件超限整批失败、不支持重试，也不支持 PDF 和 HEIC
- 严重级别：Major
- 现象：
  - 所有文件放进**一个** multipart 请求用 `fetch` 发出（`apps/web/src/api.ts:50-54`），拿不到上传进度，页面只显示“正在上传 N 张…”。
  - 前端只校验数量不超过 50（`UploadPage.tsx:49`），不校验单个文件大小。只要混进一张超过 20 MB 的文件，整个请求就会返回 `413 上传图片数量或大小超出限制`，其他合法文件也一并失败，且不提示是哪一张（已复现）。
  - 失败后没有「重试」按钮，`input.value` 也没有重置，在 Chrome 中重新选同一批文件不会触发 change 事件。
  - 服务端只接受 JPEG/PNG/WebP（`storage.ts:14-18`）。电子发票常见的 PDF 会被拒，返回 `INVALID_IMAGE`（已复现），页面只显示“未接收文件”，不说原因。从“文件”App 或电脑拷贝来的 HEIC 同样会被拒。
  - 合成测试中，23 张 12MP 照片（47 MB）在本机上传加处理用了 3.2 秒；在手机 4G 网络下同样的量需要数十秒到数分钟，任何一次抖动都得全部重来。
- 影响：手机拍照上传是第一步，这一步不稳，整个产品体验就会崩。
- 解决方案：
  - 客户端逐个校验文件（类型、≤20 MB），给出逐文件提示。
  - 客户端先压缩（canvas 或 `browser-image-compression`，长边约 2000px、JPEG 0.85，体积通常降到原来的 1/4–1/5）。
  - 改为每 1–3 张一个请求、并发 2–3，用 XHR 拿到进度，失败的文件单独重试；每次提交后重置 `input.value`。
  - 服务端对超限文件按单个拒绝，不再整单 413。
  - PDF 电子发票：首页渲染成图片后走原流程，或直接作为附件入库（M–L）。
  - 被拒原因要显示给用户：格式不支持、过大、重复（并说明是否在回收站）。
- 工作量估计：M

[P-13] 【A 实用性 / B UI/UX】手机上报销池和待处理页几乎不可用：原图当缩略图（20 张就要下载 40 MB）、页面长约 2 万像素、没有全选、触控目标过小（已测量，见 E6）
- 严重级别：Major
- 现象：
  - 卡片缩略图直接加载原图（`apps/web/src/components/ReceiptCard.tsx:11`）。没有缩略图接口，没有 `loading="lazy"`，图片接口也不返回缓存头（`routes.ts:379-406`）。实测在 375px 视口打开 20 张的报销池要下载 **40.4 MiB**，按 10 Mbps 限速需要 **33 秒**，每张 3024×4032 的图只显示为 256px 宽。
  - 每张卡片里都内嵌完整的编辑器（金额、分类、确认、退款、上传退款凭证、删除、移出），20 张的页面高约 **21,200 CSS px**。
  - 没有「全选」或「按分类全选」，也没有“已选 N 张 / 合计 ¥X”。「生成报销单」按钮在页面顶部，离底部的勾选框很远。
  - 可交互元素中 229/249 的高度或宽度小于 44px（按钮约 30px，复选框 13px）。
  - 报错信息显示在页面最顶部，用户在底部操作时看不到。
- 影响：月底一次处理几十张票，在手机上既耗流量又容易误操作（「删除凭证」紧挨着其他按钮）。
- 解决方案：
  - 上传时由 sharp 生成 320px WebP 缩略图，接口 `/api/images/:id?size=thumb` 返回 `Cache-Control: private, max-age=31536000, immutable`（图片 ID 不会变）；`<img loading="lazy" decoding="async">`。
  - 列表改为紧凑行（缩略图、商户、金额、分类、勾选），编辑器收进「编辑」抽屉。
  - 增加「全选/按分类全选」和底部吸附栏（已选 N 张 · 合计 ¥X · 生成报销单）。
  - 在 `styles.css` 中统一按钮和复选框的点击区域 ≥44px；危险操作与其他按钮拉开距离并二次确认。
- 工作量估计：M

[P-14] 【B UI/UX】609–870px 宽度下导航「设置」（部分宽度还有「历史报销单/生成预览」）够不到；切换页面时内容左右跳动（历史问题 1 未彻底修复；已测量，见 E2）
- 严重级别：Major
- 现象：
  - 只有 `@media (max-width: 38rem)`（608px）时导航才可以横向滚动（`apps/web/src/styles.css:142-146`）。宽度更大时，页头是 `flex + nowrap` 的 7 个按钮（`styles.css:28-42`），再加上 `html, body { overflow-x: hidden }`（`styles.css:9`），超出部分直接被裁掉，也滚不过去。
  - 实测：609px 时「生成预览、历史报销单、设置」三个都不可达；640–768px 时「历史报销单、设置」不可达；800–870px 时「设置」不可达；880px 以上正常。iPad 竖屏和 iPhone 横屏（844/852）都落在这个区间。
  - 1366px 带经典滚动条时，长页面（报销池）内容左边距为 227.5px，短页面（历史）为 235px，切页时左右跳 7.5px。预览页在 ≥900px 时变成全宽（`styles.css:123`），和其他页面宽度不一致。
  - 导航没有当前页高亮；「首页」和「上传凭证」都指向同一个页面。
- 影响：平板和手机横屏下用户无法进入设置和历史；在 Windows 桌面上会感到“边界不稳”。
- 解决方案：
  - 所有宽度下 `nav` 都用 `overflow-x: auto`，或者把列式页头的断点提高到约 56rem。
  - 手机上建议改成底部 Tab（上传 / 待处理 / 报销池 / 历史 / 设置），「生成预览」放到流程里而不是导航里。
  - 删除 `overflow-x: hidden` 这个“遮羞布”，修真正溢出的元素；加上 `html { scrollbar-gutter: stable; }`。
  - 导航改用 `<a href="#pool" aria-current="page">`。
  - e2e 在 375/768/834/1024/1366 五个宽度下断言导航可达、无元素越界。
- 工作量估计：S

[P-15] 【A 实用性】学习模块“只记不用”：同一商户纠正多少次，下次还是要手动再改
- 严重级别：Major
- 现象：
  - `decide()` 中的强规则只用来两件事：和 AI 一致时把中等置信度提升为 ready；不一致时转为 `pending(rule_conflict)`。**分类本身永远不会被改写**（`apps/api/src/decision.ts:50`、`63`）。仓库自己的测试 `category-independence.test.ts` 也固化了这个行为。
  - 只要出现一次不同的分类确认，已经攒下的次数就会被清零（`learning.ts:46`）。
  - 商户按规范化后**完全相等**来匹配（`learning.ts:96-107`），AI 对同一家店给出“百慕达海鲜”和“百慕达海鲜市场”这类差异就无法命中。
- 影响：用户明明“教过”，系统却每次都报冲突，仍需手动改，达不到“修正后被正确记住”的预期。
- 解决方案：
  - 强规则与 AI 冲突时，把规则分类作为**预填建议**（仍是 pending），界面显示“历史规则：百慕达食材（已确认 3 次）【一键采用】”。
  - 规则达到强规则且没有反例时，可以直接自动 ready。
  - 按分类分别累计确认次数，按多数决选择，不要一票清零。
  - 商户规范化时去掉“有限公司/分店/括号内容”，再做前缀或模糊匹配，并优先使用用户修正后的商户（P-11）。
- 工作量估计：M

[P-16] 【C 前端 / D 后端】预览 PDF 过大且每次都重新渲染：10 张凭证就有 21 MB，每保存一次又要全量重新下载
- 严重级别：Major
- 现象：
  - 附件页把原图原封不动嵌入 PDF（`apps/api/src/render/attachments.ts:54`）。草稿批次每次请求 `preview.pdf` 都会重新渲染（`routes.ts:273-284`、`render/pdf.ts:14-42`），也不带缓存头。
  - 实测 10 张 12MP 凭证的批次，`preview.pdf` 为 **21.1 MiB**。前端每次保存都会 `revision+1` 并重新拉取；按 10 Mbps 算，每次刷新约 17 秒。
  - 对账页右侧已经在单独展示原图，左侧预览却还要把全部附件页再渲染一遍。
  - 导出的定稿 PDF 同样巨大：50 张约 100 MB，超过常见邮箱 20–25 MB 的附件上限，和设计里“导出一个 PDF 发给财务”的目标冲突。
- 影响：手机上预览慢、费流量、容易卡死，导出的文件也不好发送。
- 解决方案：
  - 嵌入附件前用 sharp 按 EXIF 自动旋转，缩到长边 1600px、JPEG q80（每页约 0.3 MB，50 张约 15 MB）。如需高清版，可另提供“原图归档包”。
  - 预览接口默认只渲染表单页（例如 `?attachments=0`）。
  - 按 `batch.id` 加选项哈希缓存渲染结果，并返回 ETag 和 `Cache-Control`。
- 工作量估计：M

[P-17] 【D 后端 / G 运维】500 错误完全不记日志，也没有请求日志、监控和告警（已复现）
- 严重级别：Major
- 现象：全局错误处理直接返回 `500 INTERNAL_ERROR`，没有任何输出（`apps/api/src/app.ts:172-175`）。整个服务唯一的一条日志是启动时的 “API listening…”（`server.ts:26`）。P-04 复现时两次 500，服务端日志里一行都没有。前端的 `PdfPreview` 同样吞掉了异常。
- 影响：线上出问题时无法定位，只能靠用户截图描述，修复效率和质量都会受影响。
- 解决方案：
  - 错误处理里输出结构化日志（请求 ID、方法、路径、错误码、stack），用 `pino-http` 记录请求，并对 `Authorization` 做脱敏。
  - 接入 Sentry（前后端都有免费额度），或者给 Railway 日志配告警。
  - 用 UptimeRobot 或 Better Stack 监控 `/health`，配合 P-09 做深度检查。
- 工作量估计：S

[P-18] 【G 部署运维】Railway 的 GitHub 自动部署已断开（控制台显示 “Could not load branches”）：后端可能停在旧版本，和前端产生版本漂移
- 严重级别：Major
- 现象：原因通常是 Railway GitHub App 失去了对该仓库的访问权限。常见情形有：
  - 仓库被改名或转移。
  - GitHub App 安装时选了“仅限部分仓库”，没有包含本仓库。
  - Railway 账号绑定的 GitHub 授权过期或被撤销。
  - Railway 项目的创建者不是 `eros69991-beep` 这个 GitHub 账号。

  仓库里没有 `railway.json` 或 `railway.toml`，构建和启动配置都只存在控制台里。此外，progress.md 记录的开发方式是“在未提交的工作区里改完、暂不发布”，最新提交 `2df0973` 是否已上线**无法从这里确认**（线上访问被拦截）。
- 影响：
  - 推送不再触发后端部署。如果 Netlify 仍在自动部署前端，就会出现**前新后旧**。例如 2df0973 新增的 `POST/PUT /api/batches/:id/notes` 在旧后端上会返回 404，线上「编辑备注」就无法保存；Task 01–07 声称的修复（高清模板、长文本适配、PDF 幂等）在线上也都不会生效。
  - 回滚和审计也会失去依据，还可能有人从本地脏工作区手动部署。
- 解决方案（修复步骤）：
  1. GitHub → Settings → Applications → Installed GitHub Apps → **Railway** → Configure → Repository access，勾选 `auto-reimbursement`（或改为 All repositories）→ Save。如果 App 装在别的账号或组织下，就在仓库所有者账号下重新安装。
  2. Railway → Account Settings → 集成 / GitHub，必要时断开后重新授权。
  3. Railway → 服务 → Settings → Source：Disconnect，再 Connect Repo，选择 `eros69991-beep/auto-reimbursement`，分支选 `feature/mvp-implementation`（建议先合并到 `main` 再改成 `main`），打开自动部署，可选勾上 “Wait for CI”。
  4. 手动触发一次部署，在 Deployments 页面确认 commit 为 `2df0973`（或更新），并用浏览器打开 `/health`。
  5. 增加 `GET /api/version`，返回 Railway 注入的 `RAILWAY_GIT_COMMIT_SHA`；前端页脚显示 Netlify 的 `COMMIT_REF`，每次上线核对两者一致。
  6. 把构建、启动、健康检查写进 `railway.json`（配置即代码）。临时补救可以用 `railway up`，或者在 GitHub Actions 中配置 `RAILWAY_TOKEN` 部署。
- 工作量估计：S

[P-19] 【F 测试与可维护性】关键路径缺测试，也没有 CI：上面的 Blocker 都是现有 256+9 个测试没拦住的
- 严重级别：Major
- 现象：
  - 仓库里没有 `.github/workflows`，测试完全靠本地手动跑。
  - 9 个 e2e 里只有 1 个真正驱动了界面（`e2e/workflow.spec.ts`，桌面 1280×720），其余都是直接调 API 的契约测试。
  - 缺少的覆盖：
    - 同一分类超过 10 张（P-02）
    - 退款大于实付（P-03）
    - 超长商户（P-04）
    - 未保存直接生成（P-05）
    - 大写金额内容（P-06；函数单测存在，但函数没被调用）
    - 确认失败后凭证不可见（P-10）
    - 手机视口
    - 旧浏览器上的 PDF 预览（P-08）
    - 时区
    - 鉴权（目前没有）
  - 现有 e2e 恰好是“先点保存再生成”，所以测不出 P-05。
- 影响：修一处坏一处的风险高，“全部测试通过”也不能代表可以上线。
- 解决方案：
  - 增加 GitHub Actions：用 pnpm 11 + Node 24 依次跑 `typecheck → test → build → e2e`，e2e 改用 `channel: 'chromium'` 或在 CI 中安装 Chrome。
  - 为 P-02 到 P-10 各补一个回归用例。
  - 增加一组手机视口的 e2e（375px 下的上传、池、预览）和一个表单渲染的图像基准测试。
  - 在 PR 上强制检查通过才能合并。
- 工作量估计：M

### Minor

[P-20] 【D 后端】错误码体系不统一，部分客户端错误返回 500，文案对用户没有帮助（已复现）
- 严重级别：Minor
- 现象：
  - 只有少数路由会把 JSON 格式错误映射成 400（`app.ts:104-153` 中按路径写死）。`PATCH /batches/:id/options`、`POST /batches/:id/notes`、`POST /receipts/:id/pool` 收到坏 JSON 时都返回 `500 INTERNAL_ERROR`。
  - 上传时多带一个文本字段，返回的是 `413 上传图片数量或大小超出限制`。
  - `DELETE /api/rules/<不存在>` 返回 204。
  - `PUT /settings` 缺字段时返回 `INVALID_SIGNATURE`。
  - 未知 API 路径返回 HTML 404。
  - 几十种 400 共用同一句“请求参数无效”（`routes.ts:735`），预览页还会把原始 code 拼在前面显示给用户，例如 `INVALID_OPTIONS：请求参数无效`（`PreviewPage.tsx:25-28`）。
  - 错误映射分散在 `batchHttpError`、`correctionHttpError`、`settingsHttpError`、`maintenanceHttpError` 加上 `app.ts` 的路径表里，一共 5 处。
  - 好的一面：500 不会泄露内部细节。
- 影响：用户不知道怎么改；前端无法按 code 做针对性处理；新增路由很容易漏掉映射。
- 解决方案：
  - 建一张集中的错误表（code → HTTP 状态 + 面向用户的中文文案 + 可选修复建议），所有路由统一用一个 `toHttpError()`。
  - 所有 `express.json` 语法错误统一返回 `400 INVALID_JSON`；未知 `/api/*` 路径返回 JSON 404。
  - 前端只展示 message，把 `Failed to fetch` 之类的网络错误翻译成中文。
- 工作量估计：S

[P-21] 【D 后端】AI 调用的健壮性和成本控制偏弱
- 严重级别：Minor
- 现象：
  - 输出校验用 `.strict()`（`ai/validate.ts:35`、`48`）：多一个键、多一个关键词、金额写成“¥1,280.00”，整次结果都会作废。
  - 请求没有开 JSON 输出模式，也不容忍返回里的 ```json 代码块（`openai-compatible.ts:45-73`）。
  - 原图不压缩、不按 EXIF 纠正方向，直接 base64 发送（`openai-compatible.ts:64-66`）。
  - 429 只有 1s、3s 两次固定重试，不读 `Retry-After`（`queue.ts:15-16`、`openai-compatible.ts:84-86`）。
  - 没有每日调用上限或费用预算。
  - 超时 45s，处理得当，这一点做得对。
  - README 配置的模型名 `deepseek-v4-flash-vision-exp`（`README.md:66`）按 DeepSeek 官方 Vision 文档已是“仍可用但已退役、由最新 Flash 模型承接”的旧名。
  - 凭证图片内容不可信（提示注入），高置信度结果会自动进入报销池（`decision.ts:25` 起），没有金额上限或人工抽检。
- 影响：识别失败率和费用都偏高；恶意或篡改的票据可能以“高置信”身份直接进池。
- 解决方案：
  - 容错解析：剥掉代码块，未知键用 `.strip()` 丢弃，数组截断而不是整体拒绝；金额先去掉 ¥、元和逗号再 `parseFen`。
  - 如果提供商支持，开启 JSON 输出模式。
  - 发送前用 sharp 做 `rotate()`，并把长边缩到 2048px。
  - 429 和 5xx 用指数退避加抖动，并读取 `Retry-After`。
  - 在 SQLite 中记录每日调用次数，超过上限就暂停，并在设置页显示。
  - 把 `AI_MODEL` 更新为官方当前名称。
  - 金额超过阈值、首次出现的商户、或 evidence 中找不到金额原文时，一律转为人工确认。
- 工作量估计：M

[P-22] 【E 安全】安全响应头、限流和上传内存上限不完善
- 严重级别：Minor（鉴权补上后的剩余风险）
- 现象：
  - API 没用 helmet，响应带 `X-Powered-By: Express`，也没有 `X-Content-Type-Options`（已本地确认）。
  - Netlify 只配了 3 个头（`netlify.toml:13-19`），没有 CSP 和 Permissions-Policy。
  - 所有接口都没有限流。
  - multer 用内存存储，单个请求最多 50×20 MB，约 1 GB 全部进内存（`routes.ts:56-61`）；sharp 为了校验图片还会整图解码到内存（`storage.ts:124-131`）。
  - 做得好的地方：
    - CORS 是精确白名单，启动时就校验格式。
    - 上传按文件内容识别格式，并限制像素，防解压炸弹。
    - 文件名用 UUID，配合 `safePath` 防路径穿越。
    - 图片只输出 jpg、png、webp，不会有存储型 XSS。
- 影响：容易被拖垮或刷流量（DoS），浏览器端也缺少纵深防护。
- 解决方案：
  - API：`helmet()` 加 `app.disable('x-powered-by')`；用 `express-rate-limit` 分级限流（上传、备份、清理从严）。
  - multer 改用磁盘临时目录，或者把单次文件数降到 10 以内，配合前端分片（P-12）。
  - Netlify 增加 CSP：`default-src 'self'; connect-src 'self' <API 源>; img-src 'self' blob: data: <API 源>; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`，另加 Permissions-Policy。
- 工作量估计：S

[P-23] 【A 实用性 / D 后端】凭证和批次的“所属月份”按服务器时区计算，Railway 默认是 UTC
- 严重级别：Minor
- 现象：`localMonth()`（`receipts.ts:18-20`）和建批时的 `month`（`batches.ts:80`）都用 `getMonth()`。演示：服务器在 `TZ=UTC` 时，北京时间 10 月 1 日 00:30 上传的票被算成 `2026-09`。README 的变量清单里没有 `TZ`。报销单上的“日期”在浏览器端计算，所以不受影响。
- 影响：每月 1 日 0–8 点上传或建批的记录会归到上个月，历史和归档按月分组时出现错位。
- 解决方案：Railway 变量中加上 `TZ=Asia/Shanghai`（立即见效）；代码里显式用 `Intl.DateTimeFormat(..., { timeZone: 'Asia/Shanghai' })`；评估是否改为按凭证日期归月；用 fake timers 为月初边界补测试。
- 工作量估计：S

[P-24] 【D 后端】所有查询都是全表扫描再在 JS 里过滤，SQLite 同步 API 会阻塞整个进程
- 严重级别：Minor（今天不明显，一到两年后会成为 Major）
- 现象：
  - `Store.list()` 执行 `SELECT data FROM <表>`，然后逐行 `JSON.parse`（`db.ts:87-93`）。迁移里建的 `json_extract` 索引（`001-initial.sql`）根本没用上。
  - 报销池、待处理、`/progress`（识别时每秒轮询）、查重（每上传一张调用两次，`duplicates.ts:36-63`、`127-135`）、队列 `pump()`（每完成一张扫描 3–4 次，`queue.ts:138-169`）全部走全表。
  - 实测：1 万条凭证时，一次全表约 67 ms，上传 50 张的查重约阻塞 7.4 s；3 万条时一次约 464 ms，上传约阻塞 30 s。`node:sqlite` 的 `DatabaseSync` 是同步调用，这段时间内所有请求都会卡住。
- 影响：数据越积越慢，识别高峰时整个 API 都会卡顿。
- 解决方案：
  - 用现有索引写定向查询：按 `status`、`batchId`、`original.sha256` 过滤。
  - `getProgress` 改用 `WHERE id IN (...)`。
  - 感知哈希查重限定在近几个月，或单独建一张 phash 表。
  - 队列在内存里维护识别中的 ID 集合，不再反复扫表。
- 工作量估计：M

[P-25] 【A 实用性】离线、弱网或 AI 不可用时，提示和恢复手段不足
- 严重级别：Minor
- 现象：
  - 网络错误原样显示浏览器的英文文案，例如“修改已保存，但确认可报销失败：Failed to fetch”（已复现）。
  - 各页面加载失败后都没有“重试”按钮，只有识别进度轮询有。
  - 离开上传页后，识别进度就丢了。
  - AI 未配置时，上传页没有任何提示（只有设置页写着“未配置”），所有凭证都会进入“API 最终失败”，只能一张张点「重试识别」，没有批量重试。
  - 做得好的地方：识别失败会降级为人工录入，数据不会丢。
- 影响：用户在弱网环境下困惑，不知道怎么继续。
- 解决方案：统一把网络错误翻译成中文并提供重试按钮；上传页在 AI 未配置或失败率高时显示横幅；待处理页增加「全部重试识别」；识别进度改从服务端恢复（按最近一次上传批次）。长期可以考虑用 PWA 加 IndexedDB 做离线拍照暂存（L）。
- 工作量估计：S

[P-26] 【B UI/UX】反馈、视觉一致性和可访问性方面的细节
- 严重级别：Minor
- 现象：
  - 设置页保存、预览设置保存成功后都没有提示（`SettingsPage.tsx:12`）。
  - 错误信息不会在下一次成功操作后清除（`PreviewPage.tsx:30-66`）。
  - 按钮全部是浏览器默认样式，没有 hover、加载中状态；“忙碌”时只是置灰。
  - 日期类字段（预览页日期、设置页自定义日期）是自由文本输入，不是 `type="date"`。
  - 备注弹窗没有焦点管理，不能用 Esc 关闭（`NoteEditor.tsx:26-52`）。
  - `index.html` 写的是 `lang="en"`，标题和页头是英文 “Automatic Reimbursement Assistant”（`index.html:2`、`6`，`App.tsx:36`），而界面全是中文。
  - 报销池为空时没有空状态引导。
  - 规则表把内部枚举 `merchant：coffee` 直接展示给用户。
  - 做得好的地方：表单都用 `<label>` 包裹，文字对比度足够，有 `:focus-visible`。
- 影响：用户不确定操作是否成功；读屏软件会按英文朗读中文；手机输入日期容易出错。
- 解决方案：加一个统一的轻量 toast 和按钮状态样式；日期字段改用 `type="date"`；弹窗加焦点陷阱和 Esc 关闭；改为 `lang="zh-CN"` 和中文标题；给报销池加空状态和“去上传”引导；规则类型显示为“商户/关键词”。
- 工作量估计：S

[P-27] 【C 前端】预览页切换批次存在竞态和旧数据残留；PdfPreview 资源泄漏，并且会渲染全部附件页
- 严重级别：Minor
- 现象：
  - `PreviewPage` 的加载 effect 在 `batchId` 变化时不清空旧的 batch，也不丢弃过期响应（`PreviewPage.tsx:15-23`）。快速切换两个批次时，可能显示错误批次的数据；新数据加载完成前，页面上仍是上一批，而「生成 PDF」按钮可以点。
  - `PdfPreview` 只在成功时 `destroy`，取消或出错时不释放 worker 和文档（`PdfPreview.tsx:23-53`，`destroy` 只出现在 48 行）。每次保存（revision+1）都会新建一份。它还会把所有附件页都渲染成 canvas：10 张约 7.6 MP，30 MB 内存。
- 影响：可能对错误的批次执行操作；低端手机上内存持续上涨。
- 解决方案：effect 中先 `setBatch(null)`，并用 `AbortController` 或 `active` 标志丢弃过期响应；`PdfPreview` 在 cleanup 和取消时调用 `loadingTask.destroy()`，只渲染表单页，或用 IntersectionObserver 懒渲染。
- 工作量估计：S

[P-28] 【C 前端】hash 路由的细节问题
- 严重级别：Minor
- 现象：
  - 深链 `#batches/<id>/preview` 刷新后能正确落页，这一点可以。
  - 但点导航「生成预览」进入的 `#preview` 依赖内存中的 `selectedBatch`（`App.tsx:20`），刷新后变成“请先在报销池生成报销单”，草稿批次只能从历史页找回来。
  - 撤销批次后再点「生成预览」，会打开已撤销的批次，预览接口返回 409。
  - 导航用 `<button onClick>` 修改 hash，不能长按或在新标签页打开，也没有 `aria-current`。
- 影响：刷新后流程断开，用户找不到自己的草稿批次。
- 解决方案：`#preview` 自动跳转到最近一个草稿批次，或列出所有草稿；报销池页显示“进行中的草稿批次”；导航改为 `<a>` 链接。
- 工作量估计：S

[P-29] 【F 测试】web 单测不稳定，`pnpm test` 大约一半概率以退出码 1 失败；测试卫生问题
- 严重级别：Minor
- 现象：
  - `App.test.tsx:16-20` 渲染真实的 `App`，没有 mock `api`，会真的请求 `http://127.0.0.1:3000`。请求失败时测试环境已经销毁，于是报出 “window is not defined”，Vitest 判为 Unhandled Errors 并以退出码 1 结束（本次 4 次运行失败 2 次）。
  - 另外 `apps/web/vitest.config.ts` 没有开 `globals`，Testing Library 的自动 cleanup 不会生效。所以测试里到处用 `getAllBy…().at(-1)` 绕过前面残留的 DOM。
  - 如果开发者本机正好开着 API，这个测试还会读到本地开发库的数据。
- 影响：CI 会随机变红；测试之间相互污染，结论不可靠。
- 解决方案：`App.test.tsx` 中 `vi.mock('./api')`；在 `setup.ts` 里加 `afterEach(cleanup)`（或打开 `globals: true`），并去掉 `.at(-1)` 这类写法。
- 工作量估计：S

[P-30] 【F 可维护性】代码质量：单行超长组件、重复逻辑、没有 lint，e2e 不在类型检查范围
- 严重级别：Minor
- 现象：
  - `SettingsPage.tsx` 和 `HistoryPage.tsx` 的主体各只有**一行** JSX，长达数千字符；`NotesEditor.tsx`、`RulesEditor.tsx` 也是单行组件。
  - 重复实现的例子：
    - `isCalendarDate`（`batches.ts:425`、`settings.ts:165`）
    - `addFen`（`batches.ts:225`、`layout.ts:166`）
    - `MAX_IMAGE_BYTES`（`routes.ts:56`、`storage.ts:11`）
    - `storeImage` 与 `storeSignatureImage` 基本相同
    - 前端 `eligible()` 和后端 `isEligible()` 各写一份
  - 仓库里没有 ESLint 或 Prettier 配置。
  - `e2e/` 没有纳入类型检查。用独立 tsconfig 检查时，`e2e/fixture-runtime.ts:81` 报 TS2741（`Config` 缺 `corsOrigins`）。
  - 优点：web、api、contracts 三层边界整体清晰，金额相关的纯函数放在 contracts 中共享，这一点很好。
- 影响：改动的风险和评审成本都高，一些低级错误无法被自动发现。
- 解决方案：引入 Prettier 和 ESLint（包括 react-hooks、jsx-a11y 规则）；拆分单行组件；把重复逻辑收拢到 contracts 或 utils；在根目录加 `tsconfig.e2e.json` 并纳入 `pnpm typecheck`。
- 工作量估计：M

[P-31] 【A 实用性】恢复凭证后列表不刷新；当月有已撤销批次时，历史页「归档本月」状态显示错误
- 严重级别：Minor
- 现象：
  - 回收站里点「恢复凭证」后提示“已恢复 沃尔玛”，但报销池列表不出现这张票，手动刷新才会出现（已复现；`PoolPage.tsx:87-101` 只更新了回收站和汇总）。
  - 历史页用“当月**所有**批次都已归档”来判断显示「取消归档」（`HistoryPage.tsx:12`），而 `archiveMonth` 会跳过已撤销的批次（`archive.ts:95-97`）。所以只要当月有撤销单，归档后按钮仍显示「归档本月」，永远看不到「取消归档」。
- 影响：用户误以为恢复失败，或以为归档没有生效。
- 解决方案：恢复后重新拉取报销池列表；历史页只按未撤销的批次判断归档状态。
- 工作量估计：S

[P-32] 【A 实用性】删除后重新上传同一张图，会被判为“重复文件”，且不提示原凭证在回收站
- 严重级别：Minor
- 现象：`findDuplicates` 遍历全部凭证，包括已删除的（`duplicates.ts:42-61`）。已复现：删除后再上传同一张图，返回 `EXACT_DUPLICATE`，`duplicateId` 指向已删除的那张；页面只显示“重复文件”。
- 影响：用户会以为系统有 bug，或者重复上传多次。
- 解决方案：对已删除的凭证返回单独的错误码（如 `DELETED_DUPLICATE`），前端提供「从回收站恢复」按钮；或者在查重时跳过已删除的凭证。已归档的凭证仍应参与查重，防止跨月重复报销。
- 工作量估计：S

[P-33] 【A 实用性】定稿以后要改只能“撤销 → 重选 → 重填”，批次内的手写备注会丢失
- 严重级别：Minor
- 现象：建批时 `notes` 取的是全局备注模板的快照（`batches.ts:86`）。撤销以后重新建批，原批次的手写备注和部门、报销人等选项都要重新录入。另外，定稿前没有二次确认（见 P-05）。
- 影响：定稿后发现一个小错，就要重复大量操作。
- 解决方案：增加「基于此单重开草稿」，比如 `POST /api/batches/:id/reopen`：复制原批次的凭证、选项和备注，生成新的草稿，旧 PDF 保留为作废件；撤销时也提供“按原设置重建”。
- 工作量估计：M

[P-34] 【A 实用性 / E 安全】多用户与并发：默认单人使用，没有操作留痕，批次选项“最后写入者胜出”
- 严重级别：Minor（如果店里有多人同时使用，则升级为 Major）
- 现象：设计文档明确不做多用户和登录。两个人同时编辑同一批次的选项时，后提交的会静默覆盖先提交的，因为没有版本号或 ETag。凭证的上传、修改、确认、导出、撤销、清理都**不记录操作人和时间线**。好的一面：建批、查重、队列认领都在事务里做，并发不会造成重复入批或重复识别；README 也要求 Railway 只开 1 个副本，这一点是正确的。
- 影响：发生争议时无法追溯，财务审计缺少依据。
- 解决方案：给 batch 和 receipt 增加 `version` 字段，写接口带上版本号，冲突时返回 409；新增一张只追加的 `audit_log` 表（记录操作人、动作、对象、前后值摘要、时间）；多人使用时引入账号体系（在 P-01 基础上扩展）。
- 工作量估计：M

[P-35] 【E 安全 / 隐私】原图保留 EXIF 元数据（可能含 GPS），导出的 PDF 也原样带出
- 严重级别：Minor
- 现象：`storeImage` 原样写入上传的字节（`storage.ts:155`），PDFKit 嵌入 JPEG 时也不去除 EXIF（`attachments.ts:54`），图片接口同样返回原字节。
- 影响：手机拍照时的位置和设备信息，会随报销 PDF 一起发给财务或其他人。
- 解决方案：入库时用 sharp 执行 `rotate()` 后重新编码，默认不带 metadata（审计需要时可另存一份原件到冷存储）；PDF 和缩略图只使用去除元数据后的版本（与 P-16 一起做）。
- 工作量估计：S

### Nit

[P-36] 【B UI/UX】报销单标题下划线压字，字体与纸质样本不一致，纸张比例与需求描述不一致
- 严重级别：Nit
- 现象：标题的第一条下划线穿过“费用报销单”几个字的底部（E3/E4，由 `form-geometry.json` 中 `title.y` 和 `underlineY` 决定）。打印标签用的是细体无衬线字体，样本是宋体或楷体风格的粗字。页面尺寸为 270×165 mm（宽高比 1.636），参考图为 1.781，需求描述写的是“A4 比例”。
- 影响：和纸质样本放在一起时仍能看出差异，打印缩放是否一致也需要确认。
- 解决方案：调整标题基线或下划线的位置；标签改用 Noto Serif SC 或霞鹜文楷等宋体、楷体类字体（嵌入字体注意授权）；和财务确认纸张规格和打印缩放（100% 还是适合页面）。
- 工作量估计：S

[P-37] 【F 可维护性】README 和文档
- 严重级别：Nit
- 现象：
  - README 的部署部分写得很详细，新人按步骤 10 分钟内能在本地跑起来（Node 24 + pnpm 11 + `pnpm install` + 两个终端）。
  - 但有以下缺失：
    - 没提 `pnpm dev` 可以一条命令同时启动前后端（`scripts/dev.mjs`）。
    - 没写 e2e 的前置条件：`playwright.config.ts:6` 使用 `channel: 'chrome'`，本机必须装 Chrome。
    - 没有架构图、数据模型说明和备份恢复手册。
    - 开头没有醒目提示“当前没有鉴权”。
    - 任务说明里“Neon”的描述和代码不一致，需要统一口径。
  - 另外，`.superpowers/` 和 `docs/superpowers/` 这些流程产物混在仓库根目录。
- 解决方案：在 README 开头加“架构 / 数据存储 / 安全现状”三段；补上 `pnpm dev`、e2e 前置条件和恢复手册；把流程产物移到 `docs/history/`。
- 工作量估计：S

[P-38] 【E 安全】`pnpm audit` 有 2 个 moderate 漏洞（vitest 和 @vitest/mocker 的路径穿越，GHSA-82fw-gwwq-j7x9）
- 严重级别：Nit（只影响开发依赖，不进入生产运行时）
- 解决方案：把 vitest 升级到 ≥4.1.11，在 CI 中加上 `pnpm audit --audit-level=high` 作为门禁。
- 工作量估计：S

---

## 4. 优先级排序：Top 10 修复顺序（5.2）

**第 0 步（当天完成，不改代码，只做核查）**
1. 在 Railway 确认 `/app/data` 已挂载 Volume，按 README 第 10 步验证重新部署后数据还在，并立刻手动导出一份完整的卷数据（P-09）。
2. 在 Railway 和 Netlify 的 Deployments 页面核对线上 commit，确认前后端没有版本漂移（P-18）。
3. 如果线上已经有真实凭证，在 P-01 完成之前先临时下线公网域名，或者只保留测试数据。

| 顺序 | 问题 | 级别 | 工作量 | 排序理由 |
| --- | --- | --- | --- | --- |
| 1 | P-01 零鉴权 | Blocker | M | 数据泄露和永久删除的风险每天都存在，而且外部任何人都能触发。修完之后，其余问题才有意义 |
| 2 | P-03 退款改金额导致白屏 | Blocker | S | 一次正常的修正操作就会让报销池永久白屏，普通用户无法自救；改动小、收益大 |
| 3 | P-02 同一分类超过 10 张无法生成（连同 P-07 行线压字） | Blocker | M | 按月报销的核心流程被卡死，几乎每个月都会遇到；与 P-07 改的是同一处版式代码，应合并处理 |
| 4 | P-04 长商户名导致整批 500 | Blocker | S | 含正式发票（销售方全称）的批次无法导出，只能剔票；改成自适应字号即可 |
| 5 | P-05 未保存修改被吞并定稿锁死 | Major | S | 就是用户投诉过的问题 4，感知最强；修完能直接恢复用户对系统的信任 |
| 6 | P-06 大写金额填了阿拉伯数字 | Major | S | 输出给财务的正式单据内容不合规，可能被退单；现成函数直接接上即可 |
| 7 | P-09 数据与备份单点（含启动自检和异地备份） | Major | M | 真实数据一旦丢失无法挽回；第 0 步核查之后要尽快做异地备份 |
| 8 | P-08 PDF 预览在大量手机浏览器上失败 | Major | S | 手机是主场景，改用 legacy 构建即可修复，改动很小 |
| 9 | P-10 确认失败后凭证“失踪” | Major | S | 静默漏报，还会连带导致当月无法归档；弱网下必然会出现 |
| 10 | P-13 手机报销池（缩略图、全选、紧凑列表） | Major | M | 手机上每次打开都要下载几十 MB，勾选几十张票的操作负担很重，天天都会用到 |

紧随其后：P-17（加日志，建议和第 1–4 项同时顺手做）、P-12（上传可靠性）、P-11（改商户/日期）、P-14（导航）、P-16（PDF 体积）、P-19（CI 与回归用例）。

---

## 5. 总结（5.3）

### 整体健康度

后端的**数据正确性底座**写得相当扎实：金额全程用“分”作整数，写操作有事务，导出做到原子替换，SQL 全部参数化，上传按文件内容校验，识别队列持久化并能在重启后恢复，测试数量也可观。
问题主要出在三处：

1. **安全模型停留在“只在本机运行”的阶段**：部署到公网后没有补鉴权。
2. **版式与流程的边界没有用真实数据量压测过**：单类超过 10 张、24 字以上的商户、退款后再改金额，都会让核心流程直接走不通。
3. **手机端体验和运维可观测性明显不足**：原图当缩略图、预览只兼容最新浏览器、500 不记日志、备份与数据在同一个卷上。

作为本机单人使用的 MVP 已经可用。作为放在公网上、承载真实财务数据的生产系统，**目前还不合格**。完成 Top 10 以后，可以进入小范围真实试用。

### 做得好的地方

- **金额处理严谨**：统一用整数“分”存储，`parseFen`/`formatFen`/`netFen` 放在 contracts 里前后端共享，还有 999,999,999,999 的上限校验。
- **数据层稳健**：SQL 全部参数化，表名走白名单；迁移用 `user_version` 在事务中执行，可以重复运行；开启了 WAL。多步写操作都包在 `store.transact` 里。导出用临时文件加 rename 实现原子替换，并在事务里再次检查 `pdfPath`，能防住并发重复导出。失败路径会清理自己创建的文件。
- **上传安全**：用 sharp 按文件内容识别格式并完整解码校验，限制像素上限，文件名用 UUID，`safePath` 防路径穿越。图片只以 jpg、png、webp 输出，不会产生存储型 XSS。
- **密钥管理规范**：AI Key 只放在后端；Netlify 构建会主动校验 `VITE_API_BASE_URL`；e2e 会断言浏览器请求和静态资源里不出现 AI 凭据；git 历史里从未提交过 `.env`；前端产物中没有扫到密钥。
- **CORS 配置正确**：是精确白名单，启动时就校验格式，不允许通配符。
- **识别队列可靠**：状态存在数据库里，重启后会续跑；有重试并区分可重试和不可重试的错误；AI 迟到的结果不会覆盖人工修改；失败后可以降级为人工录入，数据不会丢。
- **生命周期完整**：软删除、回收站、撤销批次（保留作废 PDF）、按月归档/取消归档、清理原图需要输入确认口令。
- **报销单细节**：长部门名会自动缩小字号，备注超长会自动生成续页，PDF 输出字节稳定（固定 CreationDate），附件页数自动计算。
- **工程过程**：256 个单测加 9 个 e2e，TS 严格模式，pdf.js 按需懒加载（主包 gzip 后 73 KB），部署 README 写到了逐字段的粒度，progress 日志记录了验证证据。

### 两周改进迭代建议（按 1 名全栈开发、10 个工作日估算）

**第 1 周：止血，打通核心流程**
- D1–D2：P-01 访问码鉴权、限流、helmet，前端访问码页，图片和 PDF 改为带鉴权加载；同时做 P-17 错误日志与请求日志，以及 P-20 的统一错误表（顺带完成）。
- D3：P-03（金额与退款的不变量、Error Boundary），P-04（摘要自适应字号）。
- D4–D5：P-02 和 P-07 一起做，改成“每个分类一行的汇总版式”加明细页；再做 P-06 大写金额；补版式回归测试。
- 并行（运维）：P-09 启动自检、`/health` 深度检查、Litestream 加对象存储异地备份，完成一次恢复演练；P-18 恢复 Railway 自动部署，加 `/api/version`；P-23 设置 `TZ`。

**第 2 周：手机端与稳定性**
- D6：P-05（dirty 状态、导出前自动保存并二次确认）；P-10（原子确认接口，待处理页显示“修改待确认”）。
- D7：P-08（pdf.js 改用 legacy 构建，预览只渲染表单页）；P-16（附件降采样，预览加缓存）。
- D8：P-13（缩略图接口，紧凑列表，全选与底部汇总栏，点击区域 ≥44px）；P-14（导航与 `scrollbar-gutter`）。
- D9：P-11（可修改商户和日期，学习模块改用修正后的商户）；P-12 的第一步（客户端逐文件校验、压缩、逐张上传并显示进度与重试）。
- D10：P-19（GitHub Actions、上述问题的回归用例、手机视口 e2e），P-29（修复不稳定的单测）。

**如果还有余力**：P-15 让学习规则可以一键采用；P-21 增强 AI 健壮性并加每日调用上限；P-24 改为定向查询；P-33 支持“基于此单重开草稿”。
**可以放到后续迭代**：PDF 电子发票和 HEIC 支持、多用户账号与审计日志（P-34）、把图片改存对象存储。

---

## 附录 A：本地复现记录（摘要）

以下全部在仓库之外的临时目录中运行，使用的都是合成数据，没有改动仓库文件：

| 问题 | 复现方式 | 实际结果 |
| --- | --- | --- |
| P-02 | 用 API 对 11 张「食材」建批；在 375px 手机视口的界面上勾选 12 张后生成 | API 返回 `400 CATEGORY_TOO_LARGE`；界面只显示“请求参数无效” |
| P-03 | 用手机视口操作：沃尔玛凭证 197.07 元，先设退款 150.00，再把实付改为 100.00 并确认 | 页面白屏，控制台报 `INVALID_REFUND`，`/api/pool/totals` 返回 500，刷新后仍白屏；最后只能用 API 修复数据 |
| P-04 | 对含 27 字商户的凭证建批，然后请求 `preview.pdf` 和 `export` | 两个请求都返回 500，服务端日志没有任何记录 |
| P-05 | 在预览页填写部门和报销人，先点分类「下一页」，再重新填写后直接点「生成 PDF」 | 点「下一页」后两个输入框被清空；生成后按空部门定稿并锁定，之后 PATCH 返回 409 |
| P-06/P-07 | 把 10 张食材批次的第 1 页用 `pdftotext` 抽取文字，用 `pdftoppm` 转成图片 | 大写栏为“1 1 0 1 6 5”；行线穿过摘要和金额文字 |
| P-08 | 在 Chromium 141 上打开预览页，并通过 CDP 捕获被 catch 吞掉的异常 | `this[#e].getOrInsertComputed is not a function`；注入 polyfill 后可以正常适宽渲染 |
| P-10 | 用浏览器拦截 confirm 请求模拟断网，然后分别强制刷新报销池和待处理页 | 两个页面都看不到这张凭证；API 中它的状态是 `pending`，reasons 为空 |
| P-12 | 同一请求上传 1 张合法图片和 1 张 21 MB 文件；另外单独上传 1 个 PDF | 前者整单返回 413；后者返回 `INVALID_IMAGE` |
| P-13 | 在 375px 视口打开有 20 张凭证的报销池，用 CDP 统计传输量，并限速到 10 Mbps | 下载 40.4 MiB，耗时 33 秒；页面总高约 21,200 CSS px |
| P-14 | 在宽度 390–1280 之间逐档检查导航按钮能否点到 | 609–870px 之间「设置」等按钮无法点到 |
| P-16 | 对 10 张凭证的草稿批次请求 `preview.pdf` | 返回 21.1 MiB，每次请求都重新渲染 |
| P-24 | 在临时库中写入 2k、10k、30k 条凭证，测全表扫描耗时 | 分别约 16 ms、67 ms、464 ms；上传 50 张的查重约阻塞 1.5 s、7.4 s、29.6 s |
| P-29 | 连续跑 4 次 web 单测 | 2 次以退出码 1 结束（Unhandled Errors） |

## 附录 B：线上只读自查命令（本环境被出口策略拦截，请在自己电脑上执行，全部是 GET）

```bash
# 1) 存活与响应头（预期 200 和 {"status":"ok"}）
curl -sS -D - https://auto-reimbursement-production.up.railway.app/health

# 2) 验证 P-01：不带任何凭据访问只读接口。返回 200 即说明 API 对公网完全开放
#    （该接口只返回 AI 是否已配置，不含业务数据）
curl -sS -o /dev/null -w "%{http_code}\n" https://auto-reimbursement-production.up.railway.app/api/ai/status

# 3) CORS：带合法来源应返回 Access-Control-Allow-Origin；带陌生来源不应返回该头
curl -sS -D - -o /dev/null -H "Origin: https://zidongbx.netlify.app" https://auto-reimbursement-production.up.railway.app/health
curl -sS -D - -o /dev/null -H "Origin: https://example.com" https://auto-reimbursement-production.up.railway.app/health

# 4) 前端首页与安全响应头（预期包含 nosniff、DENY、strict-origin-when-cross-origin）
curl -sS -D - -o /dev/null https://zidongbx.netlify.app/

# 5) 线上前端是否为最新版本：在首页引用的 index-*.js 中查找 2df0973 新增的文案
#    “编辑备注”“恢复适宽”（请在浏览器 DevTools 的 Sources 里搜索，比命令行更方便）
```

后端版本请到 Railway 控制台的 Deployments 页面查看 commit；在 P-18 的 `/api/version` 上线之前，从外部无法只用 GET 判断后端版本。

## 附录 C：审查限制说明

- 未能访问线上环境（见第 1 节），所以对 Railway Volume、线上版本和线上 AI 配置的结论都是**待核实**的。
- 没有真实的 iPhone Safari、微信内置浏览器或国产安卓浏览器。移动端结论来自 Chromium 移动视口（带 isMobile 和 hasTouch），P-08 的兼容性判断结合了 caniuse 数据。
- 没有调用真实的 DeepSeek 接口。AI 部分是代码走查加官方文档核对的结论。
- 参考资料：caniuse 上 `Map.prototype.getOrInsertComputed` 的支持情况（https://caniuse.com/mdn-javascript_builtins_map_getorinsertcomputed）；DeepSeek 官方 Vision 文档（https://api-docs.deepseek.com/guides/vision/）。
