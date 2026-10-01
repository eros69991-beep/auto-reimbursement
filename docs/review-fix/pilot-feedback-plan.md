# 试点反馈修改方案（分区 task）

来源：2026-09-30 手机跑完整流程后的反馈（基于 58bb347）。
用法：做哪个 task 就只读本文件里该 task 列出的文件和测试，不做全仓扫描。每个 task 单独提交，做完在文末「进度」打勾，并在 `progress.md` 记一段。

## 反馈原文要点

1. 百慕达食材（武汉仓小程序的单）一直被识别成食材。
2. 对账要往下滑，滑下去就看不到报销单。
3. 同一张账单的两张截图被识别成两单，其中一张找不到支付金额。
4. 凭证编辑里的商户和退款太多余，界面繁杂，直接去掉。
5. 摘要应直接写每张金额；现在摘要重复写分类名，看不到每单金额；下面有空行却挤在一行；金额栏要写同项目合计。
6. （仅影响使用）备注栏文字偏左上，改成居中。

说明：反馈图 2 是更新前生成并已定稿的旧 PDF（大写金额还是阿拉伯数字）。定稿 PDF 不随代码变化，要看新版需在历史里撤销后重新生成。新版已做到「金额栏只写分类合计、大写金额正确」。

## 已确认的决定（2026-09-30，全部按默认）

- 武汉仓的单：默认归「百慕达食材」，整单以酒水为主的归「酒水」。由 AI 按提示词里的分类说明判断，不做「武汉仓一律百慕达」的一刀切固定规则。
- 摘要格式：
  - 每张实报金额按上传顺序排列，用空格隔开；一行放不下接着写下一行（一行约 4–7 个金额，常见的 100 多元一张放 6 个；一张最多 5 行）。
  - 分类名和合计在该分类占的几行里居中，只写一次。
  - 一个分类超过 5 行时接到下一张，写「食材（续）」和该张小计。
- 对账：app 对账区和 PDF 附件页两边都改。
- 截图合并：发现疑似同一单时提示，一键合并；也能手动勾选合并。不做全自动合并。合并时在服务器左右拼成一张图，再重新识别。

## Task 0 · 上线与数据安全（不改业务代码，主要在 Railway 网页上操作）

- 加测试环境：前后端各一个测试地址，连测试分支。验证后再合到正式分支；月底集中报销那几天不发版。
- 补回 `REQUIRE_VOLUME`：先 `railway ssh` 执行 `touch /app/data/.volume-id`，再加变量，顺序不能反。
- 备份：设置页的「备份」不含图片和 PDF，需要每月下载整个数据目录，之后改成自动备份到别处。
- 用免费监控每几分钟访问一次 `/health`。
- 正式试点前清掉测试数据，或换一个全新的卷。
- 用一个月的真实量（100 张以上）测一次上传和 PDF。附件每页约 0.3 MB，100 张约 30 MB。

## Task 1 · 分类规则（反馈 1）｜中

**原因**
- 提示词只有十个分类名，没有说明。
- 学习规则只报冲突、从不改分类。
- 手动新建的规则要确认满 3 次才生效，等于不起作用。
- AI 没认出商户时，按商户学到的规则匹配不上。

**改法**
- 提示词给每个分类加一句说明（`CATEGORY_HINTS`）。要求商户填店铺、小程序或仓库名，keywords 必须包含这些名称。
- 固定规则（`Rule.source = 'manual'`）：
  - 设置页手动添加，保存即生效。
  - 规则文字至少 2 个字，按「包含」匹配。商户规则只看商户；关键词规则看商户、关键词和识别原文。
  - 命中就直接定分类；多条固定规则给出不同分类时进待处理。
  - 优先级：人工确认 > 固定规则 > AI。
- 学习来的强规则与 AI 冲突时：仍进待处理，分类保持 AI 的结果。凭证上记下规则建议（`Receipt.ruleMatch`），编辑框里一键「改用规则分类」。
  - 这里与最初方案不同，最初是预选规则分类。改的原因：反馈图 6 那次冲突里 AI（酒水）才是对的，两边都给一键更稳。
- 学习不覆盖固定规则。学习规则可以一键「设为固定规则」。
- 设置页「套用到待处理」：用已有识别结果重新走一遍分类决策，不调用 AI。只处理未被人工改过金额、分类的待处理凭证。

**只动**
- `apps/api/src/ai/prompt.ts`
- `apps/api/src/decision.ts`
- `apps/api/src/learning.ts`
- `apps/api/src/routes.ts` 的 `/rules`
- `apps/api/src/receipts.ts`：人工改分类时清掉 `ruleMatch`
- `apps/api/src/errors.ts`：新错误码
- `packages/contracts`：`Rule.source`、`Receipt.ruleMatch`，均为可选字段
- `apps/web/src/components/RulesEditor.tsx`、`SettingsPage.tsx`
- `apps/web/src/api.ts` 的规则函数
- `PendingPage.tsx`：冲突原因显示规则
- `ReceiptEditor.tsx`：一键改用规则分类
- `ReceiptCard.tsx`：显示「按规则归类」

**测试**
- `decision.test.ts`、`learning.test.ts`、`ai.test.ts`、`category-independence.test.ts`
- 新增规则接口测试、`RulesEditor.test.tsx`
- `PendingPage.test.tsx`、`ReceiptEditor.test.tsx`

**验收**
- 图 4 那种武汉仓订单直接归百慕达食材，不进待处理。
- 手动规则保存后，下一张就生效。
- 冲突时能看到规则说的是什么，一键可选。

## Task 2 · 报销单排版：摘要写金额 + 备注居中（反馈 5、6）｜中

**改法**
- 摘要改为逐张实报金额（`FormGroup.amountsFen` 已有），不写分类名和商户；金额栏维持分类合计。
- 分类占几行按金额行数算，行线不压字。分类内部「报销项目」「金额」两栏不画横线，像合并单元格。
- 超过 5 行的分类拆到下一张。这会打破「每个分类只出现一次」的前提，排版校验和「分类顺序」的上一页/下一页要一起改。
- 备注水平、垂直居中；超长照旧走接续页。这一块可以先单独提交。
- 旧草稿按新排版放不下时，明确提示「请撤销后重新生成」；已定稿的不受影响。

**只动**
- `apps/api/src/render/form.ts`：`drawGroups`、`summarizeGroup`、`drawStructure`、`drawNote`
- `apps/api/src/render/layout.ts`：`groupHeight`、`packGroups`、`moveGroup`
- `apps/api/src/batches.ts`：`assertLayoutWithMetrics`、`moveBatchGroup`
- `routes.ts` 的 `/batches/:id/move`
- `contracts` 的 `FormGroup`：可能加可选的「第几部分」
- `apps/web/src/pages/PreviewPage.tsx` 的「分类顺序」区

**不碰**：附件页（Task 4）、AI、凭证页面。

**测试**
- `layout.test.ts`、`form.test.ts`、`batches.test.ts`、`pdf.test.ts`、`PreviewPage.test.tsx`
- `form-long-merchant.test.ts`：改写或删除

**验收**
- 3 张食材：摘要一行 `490.00 19.88 231.60`，金额 741.48。
- 40 张的分类能生成，拆成两张，两张小计之和等于总额。
- 备注在格子正中。

**实际做法（2026-09-30 已完成，详见 `progress.md`「试点反馈 Task 2」）**
- 拆分采用「紧凑填充」：先填满当前这张剩下的行再接下一张；一个分类一张放得下就整个放，不拆。`FormGroup.part` 只在拆开时才有。
- 拆开的分类在「分类顺序」里不能单独移动。
- 旧草稿放不下新排版时返回 `LAYOUT_OUTDATED`，预览区直接显示「请到历史页撤销本单，再重新生成」。
- 文字在格子里改按行框居中（原来偏下约 3pt）。

## Task 3 · 凭证界面精简（反馈 4）｜小

**改法**
- 编辑框只留日期（选填）、金额、分类、确认可报销、删除凭证。去掉商户输入和整块退款；以后有退款，直接把金额改成实际花费。
- 卡片标题不再显示编号，改成「分类 · 金额」；原金额、已退款、净额合成一个金额。旧数据有退款的，只读显示「已扣除退款 X」（原定「含退款 X」，改成这样不容易被理解成金额里含着退款）。
- 报销池、回收站、上传页里用商户名做提示的地方，改用分类加金额。
- 后端字段和接口全部保留：商户仍由 AI 识别，用于规则和查重。

**只动**
- `ReceiptEditor.tsx`、`ReceiptCard.tsx`
- `PoolPage.tsx`、`UploadPage.tsx`：文案
- `styles.css` 的 `.refund-editor`

**不碰**：整个 `apps/api`。

**测试**
- `ReceiptEditor.test.tsx`、`PendingPage.test.tsx`、`PoolPage.test.tsx`
- `e2e/workflow.spec.ts` 的退款三步：删除，或改为直接调接口

**实际做法（2026-09-30 已完成，详见 `progress.md`「试点反馈 Task 3」）**
- 卡片标题、读屏名称、报销池勾选框、「已恢复 …」提示统一用「分类 · 金额」（新文件 `apps/web/src/receiptLabel.ts`）。
- 编辑框的金额框显示净额；确认时后台的实付 = 框里的数 + 已登记的退款，退款登记不动，净额恰好是框里的数。
- 金额框下加一行小字：有退款的，填扣掉退款后实际花的钱。
- 没有改 `apps/api`；`api.ts` 的 `setRefund` / `addRefundImage` 保留。

## Task 4 · 对账（反馈 2）｜中

**改法**
- 手机对账区：
  - 上半区改成固定的「对账清单」，按报销单、分类列出每张金额，顺序同摘要，大字、可点。
  - 下半区显示当前凭证。点金额切图，清单同步高亮；报销单原样用按钮切出来看。
- 宽屏：保持左右两栏，左边加同样的清单。
- PDF 附件页页眉：「第 1 张报销单 · 食材 第 2/3 张 · 本张 19.88 · 食材合计 741.48」。
- 去掉「未识别商家」；历史页「查看预览」改名「对账 / 查看」。

**只动**
- `ReconcileWorkspace.tsx`
- `styles.css` 的 `.reconcile*`
- `HistoryPage.tsx`：按钮文案
- `apps/api/src/render/attachments.ts`：`orderedAttachments` 页眉

**不碰**：`PdfPreview.tsx`、`form.ts`。

**测试**：`ReconcileWorkspace.test.tsx`；`pdf.test.ts` 加页眉断言。

**依赖**：Task 2。

**实际做法（2026-09-30 已完成，详见 `progress.md`「试点反馈 Task 4」）**
- 对账区上半部分是「对账清单」：按「第 N 张报销单 → 分类（张数 · 合计）」列出每张凭证的实报金额，顺序就是报销单上的分组顺序和组内顺序（与摘要、PDF 附件页一致，不再另排）。金额是大字按钮，点一个，凭证图切到那张，当前这张蓝框加粗；上一张 / 下一张到哪，清单里对应的金额也滚进视野。
- 凭证图上方一行说明就是附件页页眉那句话；有旧退款的下面再写「原实付 / 退款 / 实报」。
- 手机上下分区：上半区是清单（最多四成半高，自己滚动），下半区是当前凭证；「查看报销单原样」按钮把上半区切成报销单预览，「返回对账清单」切回来。宽屏左右两栏：左边清单在上、报销单原样在下，右边是凭证。
- PDF 附件页页眉改成两行：第一行「第 1 张报销单 · 食材 第 2/3 张 · 本张 19.88 · 食材合计 741.48」（太长就缩小字号，保持一行），第二行「原始凭证」或「退款凭证」，有退款的后面加「原实付 / 退款 / 实报」。
- 对账区不再显示商户（含「未识别商家」）；历史页按钮「查看预览」改名「对账 / 查看」。
- 比原计划多动了两处：`contracts` 加 `receiptCaption`（页眉和对账区说明共用，两边写法不会对不上）；e2e `release-contract.spec.ts` 的页眉断言改成新写法。`PdfPreview.tsx`、`form.ts` 没动。

## Task 5 · 多张截图合并成一单（反馈 3）｜大

**思路**：服务器把几张截图按顺序左右拼成一张（2–3 张并排），作为新凭证重新识别；原来的几张收起，可「拆开」恢复。AI、PDF、对账、查重仍是一单一图。PDF 附件会缩到长边 1600px，所以不能竖着拼。

- **5a 后端合并/拆开**
  - 只能合并还没进报销单的凭证；被合并的截图单独再传时，提示「已合并进某一单」。
  - 文件：`contracts` `Receipt.mergedFrom/mergedInto`（可选）、新文件 `apps/api/src/merge.ts`、`routes.ts` 两个接口、`duplicates.ts` `findDuplicates`、`receipts.ts`（列表和恢复时排除合并来源）。
  - 测试：新增 `merge.test.ts`，修改 `duplicates.test.ts`。
- **5b 识别**
  - 提示词说明可能是拼接截图；结果加可选的「截图不完整」「订单号」。
  - 文件：`ai/prompt.ts`、`ai/validate.ts`、`contracts` `Analysis`。
  - 测试：`ai.test.ts`。
- **5c 前端**
  - 待处理页勾选后「合并为一单」。
  - 疑似同一单时提示：同次上传、前后相邻、日期或商户相同，且其中一张缺金额或被标为不完整。
  - 卡片显示「由 N 张合并」和「拆开」。
  - 文件：`PendingPage.tsx`、`ReceiptCard.tsx`、`web/src/api.ts`。
  - 测试：`PendingPage.test.tsx`。

**依赖**：Task 1（`prompt.ts`）、Task 3（`ReceiptCard.tsx`）。

**临时办法**：安卓用长截图；或删掉只有商品列表的那张，只留带合计的。

**实际做法（2026-09-30 已完成，详见 `progress.md`「试点反馈 Task 5」）**
- 合并：`POST /api/receipts/merge`（2–3 张，不重复）把截图左右拼成一张（同一高度，中间 6px 灰线，截图用 PNG、照片用 JPEG），建成新凭证重新识别；来源凭证保留但隐藏（`deletedAt` 加 `mergedInto`），所以报销池、队列、查重、生成报销单等原来就跳过已删除凭证的地方都不用改。`POST /api/receipts/:id/split` 拆开，来源恢复原样，合并后的凭证和拼图删掉（识别结果和修改会丢）。只有还没进报销单的凭证能合并；进了报销单、归档、登记过退款的合并凭证不能拆。
- 再传一张已经合并过的截图，提示「已合并进某一单」；回收站里看不到被合并隐藏的来源；归档后清理原图时来源截图一并清掉。
- 识别：提示词说明有拼接图，AI 多返回可选的 `incomplete`（只拍到订单一部分）和 `orderNo`（订单号）；`incomplete` 为真的凭证一律进待处理，原因「截图不完整」。
- 疑似同一单：`contracts` 的 `suggestMerges`。上传顺序相邻（相隔不超过 3 张）、上传时间相差不超过 10 分钟；订单号都识别出来时相同才提示，否则商户、日期不冲突且至少一项相同，并且其中一张看起来不完整。待处理页上方显示「疑似同一单」，可「合并这 N 张」或「不是同一单」。
- 手动合并：待处理页和报销池页都能勾选 2–3 张「合并为一单」；合并后页面自己等识别完（`useRecognitionWatch`，每秒查一次，最多 60 次）并说明去向；「拆开」按钮在这两页的卡片下面，点了先确认。
- 比原计划多动了几处：`archive.ts`（清理来源原图）、`receipts.ts` / `UploadPage.tsx`（已合并截图的重复提示）、`PoolPage.tsx`（报销池里也能合并和拆开）、新增 `useRecognitionWatch.ts`、`decision.ts`（不完整截图的处理）。`ReceiptCard.tsx` 只加了「由 N 张截图合并」一行，拆开按钮放在页面里。
- 还没验证：AI 对拼接图的识别效果（没有真实密钥，测试用的是替身），试点时要用真实截图验一次。

## 第二轮反馈：手机对账显示不全、报销单预览加载失败（Task 6、7、8）

来源：Task 1–5 上线后再跑一遍（基于 273c83c）。
- 手机上对账页显示不全。
- 手机上报销单预览「加载失败」，电脑端左边的报销单预览也「加载失败」。（后来查明：Mac 和 iPhone 的 Safari 上都会失败，原因是 Safari 不支持 pdf.js 读页面文字用的写法，和网络无关——见下面「Task 6 补丁」。）
- 问能不能直接部署到国内的服务器上。

## Task 6 · 报销单预览加载失败、对账图太大｜中

**改法**
- 6a（后端）：已定稿批次的预览只给报销单页。导出 PDF 时多存一份「只有报销单页」的小文件，预览优先用它；老批次没有时退回整份。
- 6b（前端 `PdfPreview`）：加载进度、慢网提示、失败时说原因并「重试」、技术细节可截图；完整 PDF 里的凭证附件页不画。
- 6c（后端 + 前端）：对账页的凭证图请求缩小版（`?size=view`，只对超过 1.5 MiB 的大图），下载可取消。
- 配套：合并凭证记下每张截图的位置（`ImageRef.panels`），给 Task 7 用。

**只动**
- `render/pdf.ts`（导出多存一份副本）、`routes.ts`（预览、`original-image`）、`thumbs.ts`、`merge.ts`、`contracts`（`pdf-form`、`panels`）
- `PdfPreview.tsx`、`AuthedImage.tsx`、`api.ts`

**实际做法（2026-09-30 已完成，详见 `progress.md`「试点反馈 Task 6」）**
- 定稿后的预览：副本只有几十 KB（测试批次 15.7 KB，整份 128 KB），带 ETag、长缓存、支持 304；副本丢了或损坏时退回整份。副本不影响下载、归档；存不进去也不挡导出。
- 老批次（改动前定稿的）没有副本，仍要下整份 PDF；重新生成并定稿后才有。
- 没解决的：服务器在境外、前端在 Netlify，国内手机访问慢且不稳——见 Task 8。

**Task 6 补丁（2026-10-01 已完成，详见 `progress.md`「Task 6 补丁」）**
- 上面「少下载、说原因、能重试」没有解决用户看到的失败。推上去后用户在 iPhone（Safari 18.6）和 Mac（Safari 26.5）上截图：下载已完整（17 KB / 17 KB），错误是 `TypeError: undefined is not a function (near '...i of e...')`。真正的原因：`PdfPreview` 为认出附件页调用了 pdf.js 的 `getTextContent()`，它内部用 `for await` 遍历 `ReadableStream`，Safari 到 26.x 不支持（Safari 27 才有）。
- 改成直接读 `streamTextContent()` 的读取器；某页文字读不出时仍把这页画出来（不标序号）；「技术细节」多带堆栈前几行。
- 新增 `e2e/safari.ts` 的 `pretendToBeSafari`（让页面缺这项功能），`reconcile-phone.spec.ts` 都先调用它；单元测试里假 pdf.js 的 `getTextContent()` 也照 Safari 的样子抛错。在云端真 WebKit 里先复现了和用户一样的错误，再验证修好。

## Task 7 · 手机对账重做｜中

**改法（只改前端，≥900px 的电脑布局不变）**
- 窄屏一次只显示一块：「凭证」（默认）、「清单」、「报销单」三个标签整屏切换；点清单金额直接切到凭证。
- 凭证图占满剩下的高度（390×664 约 362px，原来 140–239px）；「全屏查看」里有翻页、放大缩小、截图切换，Esc 关闭。
- 合并凭证逐张截图看（截图 1 / 截图 2 / 整图），每张撑满屏幕宽。
- 报销单预览第一次点开才加载；窄屏上按至少 960px 宽画，区内滑动看。

**只动**
- `ReconcileWorkspace.tsx`（重写）、新增 `VoucherViewer.tsx`、`useMediaQuery.ts`、`styles.css` 的 `.reconcile*` / `.attachment*` / `.voucher-fullscreen*`

**实际做法（2026-09-30 已完成，详见 `progress.md`「试点反馈 Task 7」）**
- 如上；新增 `e2e/reconcile-phone.spec.ts`（手机、手机加载失败重试、电脑各一条，外加 Task 6 补丁里的 Safari 替身自检一条），在真实 Chromium 里验证布局、对位、全屏、失败重试。
- 顺手修了「放大」在真实浏览器里没有效果的老问题（全局 `img { max-width: 100% }`）。

## Task 8 · 国内 / 香港部署｜未开始（等用户确认三件事）

问题：后端在 Railway（境外）、前端在 Netlify，国内手机访问本身就慢、不稳；老板的门店在国内，这会一直影响使用。

开工前需要用户确认：
1. 门店和老板主要在哪里（大陆、香港、其他）。
2. 预算（服务器月费、域名、是否愿意买备案服务）。
3. 备案主体（大陆服务器上用域名对外提供服务要先 ICP 备案，主体是公司还是个人，这决定能不能做、要多久）。

做法（草案，确认后再细化）：
- 把前后端放到同一台国内（或香港）服务器上：Docker 化（`Dockerfile`、`docker-compose`），数据目录挂载持久卷，前端静态文件由同一个域名提供（不再跨域，也不依赖 Netlify），反向代理配好 HTTPS。
- 部署说明（给非技术人员能照着做的一页）、备份和恢复办法、更新办法。
- 识别用的 DeepSeek 服务在国内，服务器放国内后这一段也更近。

## 多个 task 共用的文件

| 文件 | 涉及 task |
|---|---|
| `packages/contracts/src/index.ts` | 1、2、5，各加可选字段 |
| `apps/api/src/routes.ts` | 1、2、5，各改自己的接口 |
| `apps/api/src/ai/prompt.ts` | 1 → 5 |
| `apps/web/src/api.ts` | 1、2、5 |
| `ReceiptCard.tsx`、`ReceiptEditor.tsx`、`PendingPage.tsx` | 1（小改）→ 3 → 5 |
| `ReconcileWorkspace.tsx`、`PdfPreview.tsx`、`styles.css` 的对账部分 | 4 → 6 → 7 |
| `merge.ts`、`contracts` 的 `ImageRef` | 5 → 6（`panels`）→ 7 |

按 1 → 7 顺序做不会冲突；Task 3 最小，也可以提前。

## 以后多店时再做（卖点）

- 改动留痕：AI 识别值与最终提交值不同时记录，总部导出里标出。
- 试点统计：每月张数、AI 直接通过率、人工改动数。
- 给店员的一页纸使用说明。

## 进度

- [ ] Task 0（用户在 Railway 操作）
- [x] Task 1 分类规则（2026-09-30，见 `progress.md`「试点反馈 Task 1」）
- [x] Task 2 报销单排版（2026-09-30，见 `progress.md`「试点反馈 Task 2」）
- [x] Task 3 凭证界面精简（2026-09-30，见 `progress.md`「试点反馈 Task 3」）
- [x] Task 4 对账（2026-09-30，见 `progress.md`「试点反馈 Task 4」）
- [x] Task 5 截图合并（2026-09-30，见 `progress.md`「试点反馈 Task 5」）
- [x] Task 6 报销单预览加载失败、对账图太大（2026-09-30，见 `progress.md`「试点反馈 Task 6」）
- [x] Task 6 补丁 Safari 上报销单预览全部加载失败（2026-10-01，见 `progress.md`「Task 6 补丁」）
- [x] Task 7 手机对账重做（2026-09-30，见 `progress.md`「试点反馈 Task 7」）
- [ ] Task 8 国内 / 香港部署（未开始，等用户确认门店所在地、预算、备案主体）
