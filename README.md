# 自动报销助手

本仓库是 pnpm monorepo：React/Vite 前端位于 `apps/web`，Express API 位于
`apps/api`，共享类型位于 `packages/contracts`。生产部署使用 Netlify 托管前端、
Railway 托管 API。

## 本地开发

需要 Node.js 24 和 pnpm 11。安装依赖后，在两个终端分别启动 API 与网页：

```sh
pnpm install --frozen-lockfile
pnpm dev:api
```

```sh
pnpm dev:web
```

API 默认监听 `127.0.0.1:3000`，前端默认直接访问
`http://127.0.0.1:3000`。如需本地 DeepSeek 识别，将 `.env.example` 复制为
`.env`，再填写三个 `AI_*` 变量；`.env` 已被 Git 忽略。

后端设置：

- `HOST`：默认 `127.0.0.1`。
- `PORT`：默认 `3000`，必须是 1–65535 的整数。
- `DATA_DIR`：默认仓库根目录下的 `data`。
- `CORS_ORIGINS`：逗号分隔的完整 HTTP(S) origin，不允许路径、通配符或尾部斜杠。
- `CONCURRENCY`：只允许 3–5，默认 4。
- `AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY`：必须三个同时填写或全部不填。

前端只读取 `VITE_API_BASE_URL`。本地缺省时使用
`http://127.0.0.1:3000`；不要创建任何 `VITE_AI_*` 变量。

## Railway 后端配置清单

先部署后端并取得公网域名，再配置 Netlify。当前包含部署修复的分支是
`feature/mvp-implementation`；若已将它合并到生产分支，则选择合并后的生产分支。

在 Railway 打开后端服务的 **Settings**，逐项填写：

| Railway 字段 | 填写值 |
| --- | --- |
| Source / Branch | `feature/mvp-implementation`，或包含这些改动的生产分支 |
| Root Directory | `/` |
| Builder | `Railpack` |
| Build Command | `pnpm install --frozen-lockfile` |
| Start Command | `pnpm run start:api` |
| Healthcheck Path | `/health` |
| Healthcheck Timeout | `300` 秒 |
| Restart Policy | `Always` |
| Replicas | `1` |

不要把 `AI_BASE_URL`、`AI_MODEL` 或 `AI_API_KEY` 填进 Healthcheck Path；该字段
只能是 `/health`。

在服务的 **Variables** 中添加：

| Railway 变量 | 填写值 | 是否秘密 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 否 |
| `DATA_DIR` | `/app/data` | 否 |
| `CORS_ORIGINS` | `https://zidongbx.netlify.app` | 否 |
| `AI_BASE_URL` | `https://api.deepseek.com` | 否 |
| `AI_MODEL` | `deepseek-v4-flash-vision-exp` | 否 |
| `AI_API_KEY` | 你自己的 DeepSeek API Key | **是，只在 Railway 中填写** |
| `CONCURRENCY` | `4`，可选 | 否 |

不要手工添加 `PORT`；Railway 会在运行时自动注入它。根据 2026-09-14 的
DeepSeek 官方文档，图片输入需要 vision 模型
`deepseek-v4-flash-vision-exp`，OpenAI 兼容 base URL 是
`https://api.deepseek.com`。模型仍标记为实验性；若 DeepSeek 后续更名，以其官方
Vision 文档为准，只更新 Railway 的 `AI_MODEL`。

### Railway Volume

SQLite 数据库、上传的原始凭证、退款凭证、签名和导出的 PDF 都位于
`DATA_DIR` 下。没有 Volume 时，重新部署可能丢失这些文件。

在后端服务的 **Volumes** 页面：

1. 点击 **Add Volume**。
2. 将 **Mount Path** 精确填写为 `/app/data`。
3. 将 Volume 连接到这个后端服务。
4. 初期保持一个副本；不要把 Replicas 调成 2 或更多。

应在上传真实凭证之前挂载 Volume。Volume 只在运行时可用，构建阶段不可用，
因此 Build Command 不应尝试访问 `/app/data`。

### Railway 公网域名与健康检查

在 **Settings → Networking** 点击 **Generate Domain**，记录完整 HTTPS origin，
例如 `https://example-production.up.railway.app`。不要在后面添加 `/api`。

打开：

```text
https://你的域名.up.railway.app/health
```

必须得到 HTTP 200 和：

```json
{"status":"ok"}
```

`/health` 不调用 DeepSeek，也不会返回任何 AI 配置或密钥。

## Netlify 前端配置清单

在 Netlify 打开站点 `zidongbx` 的 **Project configuration → Build & deploy →
Continuous deployment → Build settings**：

| Netlify 字段 | 填写值 |
| --- | --- |
| Production branch | `feature/mvp-implementation`，或包含这些改动的生产分支 |
| Base directory | 留空（仓库根目录） |
| Package directory | `apps/web`（仅当界面显示该字段时） |
| Build command | 使用 `netlify.toml`；等效值为 `node test/validate-netlify-env.mjs && pnpm --filter @auto-reimbursement/web build` |
| Publish directory | `apps/web/dist` |
| Functions directory | 留空 |

`netlify.toml` 已固定 Node.js 24，并配置 SPA fallback 与基础安全响应头。

在 **Environment variables** 中只添加：

```text
VITE_API_BASE_URL=https://你的-Railway-域名.up.railway.app
```

该值必须是 HTTPS origin：不带尾部 `/`，不带 `/api`，不带路径、查询参数或账号
信息。保存后触发一次新的 Production deploy。Vite 在构建时嵌入该值，因此只改
变量而不重新部署不会更新网页。

不要在 Netlify 中添加 `AI_BASE_URL`、`AI_MODEL` 或 `AI_API_KEY`。所有以
`VITE_` 开头的变量都可能进入浏览器产物，绝不能创建 `VITE_AI_API_KEY`。

如果 `VITE_API_BASE_URL` 缺失或格式错误，Netlify 构建会主动失败并显示清晰的
错误，而不是发布一个错误连接用户本机 API 的页面。

## 推荐部署顺序

1. 推送或合并包含本部署修复的分支。
2. 在 Railway 选择该分支并填写 Build、Start、Healthcheck 字段。
3. 在 Railway 挂载 `/app/data` Volume。
4. 在 Railway Variables 填写非秘密变量，并由你本人填写 `AI_API_KEY`。
5. 重新部署 Railway，确认 `/health` 返回 200。
6. Generate Domain，复制 Railway HTTPS origin。
7. 在 Netlify 添加 `VITE_API_BASE_URL`，确认分支、构建和发布目录。
8. 触发 Netlify Production deploy，打开 `https://zidongbx.netlify.app`。
9. 上传一张不敏感的测试凭证，确认识别、图片显示和修改操作正常。
10. 重新部署一次 Railway，确认测试记录和图片仍存在，以验证 Volume。

## 数据、备份与安全边界

本地数据默认保存在 `data/`，数据库为 `data/app.sqlite`；月度文件保存在
`YYYY-MM/originals`、`YYYY-MM/refunds` 和 `YYYY-MM/exports`。Railway 上的等价
根目录是 `/app/data`。

设置页生成的结构化备份包含一致的 SQLite 快照、设置、学习规则和文件索引，
但不包含原始图片、退款证据、导出 PDF 或提供商密钥。完整恢复仍需单独备份整个
Volume。复制或恢复数据前应先停止 API，让识别队列与 SQLite 正常关闭。

CORS 只限制其他网页从浏览器读取或提交请求，它不是用户身份验证。当前 MVP 没有
登录系统，因此不要把 Railway API 域名公开分享，也不要在完成身份验证设计前用于
多人或高敏感生产数据。

## 本地验证

```sh
pnpm test
pnpm typecheck
```

模拟 Netlify 生产构建时，提供一个非秘密 API origin：

```sh
VITE_API_BASE_URL=https://api.example.railway.app node --test test/netlify-deploy.test.mjs
```

Windows PowerShell：

```powershell
$env:VITE_API_BASE_URL='https://api.example.railway.app'
node --test test/netlify-deploy.test.mjs
Remove-Item Env:VITE_API_BASE_URL
```
