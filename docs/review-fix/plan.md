# 审查修复计划（review-fix）

依据：`docs/review-fix/review-report.md`（Claude Code 只读审查，2026-09-27，38 个问题）。
执行原则：按报告第 4 节 Top 10 与两周迭代顺序，按轻重缓急分 Task；每个 Task 完成后跑相关测试，最后全量回归。

## 运维前置（需用户在控制台操作，代码无法代做）

- [ ] Railway 确认 `/app/data` Volume 已挂载；重新部署后数据仍在；手动导出一份卷快照（P-09 第 0 步）
- [ ] Railway 重连 GitHub 自动部署（P-18 修复步骤 1–4）
- [ ] 鉴权上线前：如线上已有真实凭证，评估临时下线或仅保留测试数据（P-01 第 0 步）
- [ ] 鉴权上线后：在 Railway 设置 `ACCESS_CODE_SHA256`，并更换一次 Railway 域名
- [ ] Railway 变量加 `TZ=Asia/Shanghai`（P-23）

## Task 列表（按优先级）

| Task | 问题 | 级别 | 工作量 | 状态 |
| --- | --- | --- | --- | --- |
| T01 | P-01 访问码鉴权 + helmet + 限流 + 前端访问码页 + 图片/PDF 带鉴权加载 | Blocker | M | 进行中 |
| T02 | P-17 错误/请求日志 + P-20 统一错误表 | Major/Minor | S | 待做 |
| T03 | P-03 退款>实付白屏（前后端校验 + Error Boundary + 存量排查脚本） | Blocker | S | 待做 |
| T04 | P-04 长商户名整批 500（摘要自适应字号/截断 + 错误映射） | Blocker | S | 待做 |
| T05 | P-02+P-07 单类超 10 张无法生成 + 行线压字（改汇总版式+明细页） | Blocker | M | 待做 |
| T06 | P-06 大写金额接入 `chineseUppercase()` | Major | S | 待做 |
| T07 | P-05 未保存修改被吞 + 定稿前二次确认 | Major | S | 待做 |
| T08 | P-10 确认失败凭证失踪（原子确认接口） | Major | S | 待做 |
| T09 | P-08 pdf.js 改 legacy 构建 | Major | S | 待做 |
| T10 | P-16 附件降采样 + 预览缓存/只渲染表单页 | Major | M | 待做 |
| T11 | P-13 手机报销池（缩略图接口、紧凑列表、全选、底部汇总栏、≥44px） | Major | M | 待做 |
| T12 | P-14 导航 609–870px 不可达 + scrollbar-gutter | Major | S | 待做 |
| T13 | P-11 可修改商户/日期（含学习模块用修正值） | Major | M | 待做 |
| T14 | P-12 上传可靠性（逐文件校验、压缩、分批上传、进度、重试） | Major | M | 待做 |
| T15 | P-09 启动自检 + /health 深度检查（代码部分） | Major | S | 待做 |
| T16 | P-18 /api/version + railway.json | Major | S | 待做 |
| T17 | P-23 时区修正（代码显式 Asia/Shanghai） | Minor | S | 待做 |
| T18 | P-19 GitHub Actions CI + 回归用例 | Major | M | 待做 |
| T19 | P-29 web 单测不稳定（mock api + cleanup） | Minor | S | 待做 |
| T20 | Minor 批次：P-25 弱网提示 / P-26 toast与细节 / P-27 预览竞态 / P-28 hash路由 / P-31 恢复刷新 / P-32 回收站重复提示 / P-35 EXIF / P-36 标题下划线 / P-37 README / P-38 vitest升级 | Minor/Nit | S×n | 待做 |
| T21 | 全量回归（test+typecheck+e2e+build）+ 提交推送 + 交付说明 | — | — | 待做 |

## 暂缓（后续迭代）

- P-15 学习规则一键采用（M）、P-21 AI 健壮性/费用上限（M）、P-24 定向查询（M）、P-33 重开草稿（M）、P-34 多用户/审计（M）、PDF/HEIC 上传支持（M–L）、图片改存对象存储（L）、Neon/Postgres 迁移（L）

## 进度记录

每个 Task 的完成情况、验证证据记录在 `docs/review-fix/progress.md`（随任务推进更新）。
