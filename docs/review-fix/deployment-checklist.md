# 部署操作单（Railway + GitHub + Netlify）

按顺序执行，每步都有「操作」和「验证」。全程约 20–30 分钟。

> 两个容易踩的坑：
> - 健康检查地址是 **`/health`**（不带 `/api`）。`/api/...` 下的地址都要访问码，浏览器直接打开会返回 401。
> - `REQUIRE_VOLUME=1` 必须等卷上的标记文件建好之后再加（第 2 步），先加会让服务拒绝启动、而且进不了 Shell 补救。

---

## 第 0 步：准备

- 生成一个**访问码**：建议用随机字符串，16 位以上，例如在终端执行 `openssl rand -base64 18`。不要用生日、手机号。这个码以后就是打开系统的唯一钥匙，只告诉要用的人。
- 算出它的 SHA-256（**注意 `printf` 不要换行**）：

```bash
# Mac
printf '你的访问码' | shasum -a 256
# Git Bash / Linux
printf '你的访问码' | sha256sum
```

输出第一列那串 64 位十六进制就是 `ACCESS_CODE_SHA256` 的值。

---

## 第 1 步：Railway 环境变量

**操作**：Railway 控制台 → 你的项目 → 后端服务 → **Variables**，新增：

| 变量名 | 值 | 说明 |
|---|---|---|
| `ACCESS_CODE_SHA256` | 第 0 步算出的 64 位十六进制 | 不存明文，只存哈希 |
| `TZ` | `Asia/Shanghai` | 可选：让日志时间戳显示北京时间（业务日期、归月已固定按北京时间计算，不依赖它） |

`TRUST_PROXY` 一般不用填：在 Railway 上会自动按 1 层代理识别真实客户端 IP（限流按 IP 分桶靠它）。只有在 Railway 前面再加了 Cloudflare 之类的代理时才填 `2`。

**这一步先不要加 `REQUIRE_VOLUME`**，第 2 步建好标记文件后再加。

**验证**：变量保存后 Railway 会自动重新部署。部署完成后：

- 浏览器打开 `https://<你的railway域名>/health`，应返回 200 和 `{"status":"ok"}`。
- 浏览器打开 `https://<你的railway域名>/api/receipts?view=pool`，应返回 **401**（没带访问码），说明鉴权生效。

---

## 第 2 步：确认持久卷（Volume）并开启卷检查

**操作**：

1. Railway 服务 → **Volumes** 页签，确认有一个 Volume 挂载到 `/app/data`。没有就 **Add Volume** → Mount Path 填 `/app/data` → 保存，等它重新部署完成。
2. 打开服务的 Shell（Railway CLI 执行 `railway ssh`），在卷上创建标记文件：

```bash
touch /app/data/.volume-id
ls -la /app/data/.volume-id
```

3. 回到 **Variables**，再添加 `REQUIRE_VOLUME` = `1`，等自动重新部署完成。

**验证**：`https://<你的railway域名>/health` 仍返回 200；Railway 日志里**没有** REQUIRE_VOLUME 报错。

> ⚠️ 没有 Volume 时 SQLite 数据库和凭证图片会在每次部署后丢失。`REQUIRE_VOLUME=1` 的作用是：以后万一卷没挂上，服务直接拒绝启动，而不是把数据写进会被清空的临时盘。
> 如果不小心先加了 `REQUIRE_VOLUME` 导致服务起不来：先删掉这个变量，等服务恢复，再按上面 1→2→3 的顺序来。

---

## 第 3 步：GitHub 授权 Railway 自动部署

**操作**：

1. GitHub → 头像 → **Settings** → **Applications** → **GitHub Apps** → 找到 **Railway** → Configure。
2. 确认 `eros69991-beep/auto-reimbursement` 在授权仓库列表里；不在就加上。
3. Railway 项目 → **Settings** → **Source**，确认连接的是本仓库、分支是 `feature/mvp-implementation`，并开启自动部署（push 即部署）。

**验证**：推送一个提交（或看本次已推送的提交），Railway **Deployments** 页应自动出现一条新的部署记录且成功。点开构建日志，确认 Node 版本是 **v24.21.0**（`railway.json` 已改用 Railpack 构建器，它会按 `.nvmrc` 安装这个精确版本）。

---

## 第 4 步：更换 Railway 域名

> 原因：访问码上线前，旧域名可能被无鉴权地访问/收录过，按已泄露处理。

**操作**：Railway 服务 → **Settings** → **Networking** → **Generate Domain** 生成新域名（或绑自定义域名），删除旧域名。然后到 Netlify 把 `VITE_API_BASE_URL` 改成新域名，并重新部署前端。

**验证**：浏览器打开**新**域名的 `/health` 返回 200；旧域名无法访问。

---

## 第 5 步：核对后端版本

`/api/version` 也需要访问码，浏览器地址栏直接打开会 401，请用终端（把访问码和域名换成你的）：

```bash
curl -H "Authorization: Bearer 你的访问码" https://<新域名>/api/version
```

**验证**：返回 JSON 里的 `commit` 与 GitHub 上 `feature/mvp-implementation` 分支最新提交一致。前端目前没有显示版本号的地方，前端版本请在 Netlify 的 Deploys 页核对对应的 commit。

---

## 第 6 步：存量数据体检（只读）

**操作**：在服务的 Shell（`railway ssh`）里执行：

```bash
node scripts/audit-refunds.mjs /app/data/app.sqlite
node scripts/audit-pending.mjs /app/data/app.sqlite
node scripts/repair-file-hashes.mjs /app/data/app.sqlite
```

**验证**：

- `audit-refunds`：检查「退款金额 > 实付金额」的脏数据，输出 0 条即正常；有问题按提示在界面里把退款调到不超过实付。
- `audit-pending`：检查「状态是待处理、但没有任何待处理原因」的凭证（旧版两步确认失败留下的），输出 0 条即正常；有的话到「待处理」页打开，标记为「修改待确认」，确认即可。
- `repair-file-hashes`：只有部署过 539c679 至本次修复之间的版本、并在那段时间上传过凭证时才会发现问题（症状：生成 PDF 报「缺少报销凭证图片」）。默认只读列出；确认无误、**先备份整个 `/app/data`** 后，再加 `--apply` 修复。

---

## 第 7 步：端到端冒烟（手机上做一遍）

用手机浏览器打开前端（Netlify 地址），完整走一遍：

1. 输入访问码 → 进入首页 ✅
2. **用手机相机拍一张**小票上传 → 识别出金额/商户/日期 ✅
3. 改一下商户名 → 切到别的页面再回来 → 修改还在 ✅
4. 生成报销单 → 在对账页上半区能看到报销单、下半区能看到凭证图片 ✅
5. 点「生成 PDF」成功（不报「缺少报销凭证图片」）→ 打开 PDF，行线不压字、金额大写正确、凭证页都在 ✅
6. 撤销这批 → 凭证回到报销池 ✅

全部通过 = 部署完成 🎉

---

## 出问题怎么办

| 现象 | 先看哪里 |
|---|---|
| 服务起不来 | Railway 日志 → 多半是 Volume 没挂，或先加了 `REQUIRE_VOLUME` 还没建 `.volume-id`（见第 2 步） |
| 401 一直拒绝 | `ACCESS_CODE_SHA256` 算错了？确认是 `printf` 不带换行的哈希 |
| 上传提示「上传过于频繁」 | 10 分钟内上传请求超过 200 次（约 600 张），稍后再点「重试失败文件」；如果前面还有 Cloudflare 等代理，检查 `TRUST_PROXY` 是否设为 2 |
| 生成 PDF 报「缺少报销凭证图片」 | 运行第 6 步的 `repair-file-hashes`；仍有问题说明对应图片文件缺失或损坏 |
| 前后端数据对不上 | 用第 5 步的命令核对 commit，清浏览器缓存 |
| CI 红了 | GitHub Actions 页看失败步骤，本地 `pnpm typecheck && pnpm test` 复现 |
