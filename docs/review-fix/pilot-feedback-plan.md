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
  - 每张实报金额按上传顺序排列，用空格隔开；一行放不下接着写下一行（一行约 6 个金额，一张最多 5 行）。
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

## Task 3 · 凭证界面精简（反馈 4）｜小

**改法**
- 编辑框只留日期（选填）、金额、分类、确认可报销、删除凭证。去掉商户输入和整块退款；以后有退款，直接把金额改成实际花费。
- 卡片标题不再显示编号，改成「分类 · 金额」；原金额、已退款、净额合成一个金额。旧数据有退款的，只读显示「含退款 X」。
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

## 多个 task 共用的文件

| 文件 | 涉及 task |
|---|---|
| `packages/contracts/src/index.ts` | 1、2、5，各加可选字段 |
| `apps/api/src/routes.ts` | 1、2、5，各改自己的接口 |
| `apps/api/src/ai/prompt.ts` | 1 → 5 |
| `apps/web/src/api.ts` | 1、2、5 |
| `ReceiptCard.tsx`、`ReceiptEditor.tsx`、`PendingPage.tsx` | 1（小改）→ 3 → 5 |

按 1 → 5 顺序做不会冲突；Task 3 最小，也可以提前。

## 以后多店时再做（卖点）

- 改动留痕：AI 识别值与最终提交值不同时记录，总部导出里标出。
- 试点统计：每月张数、AI 直接通过率、人工改动数。
- 给店员的一页纸使用说明。

## 进度

- [ ] Task 0（用户在 Railway 操作）
- [x] Task 1 分类规则（2026-09-30，见 `progress.md`「试点反馈 Task 1」）
- [ ] Task 2 报销单排版
- [ ] Task 3 凭证界面精简
- [ ] Task 4 对账
- [ ] Task 5 截图合并
