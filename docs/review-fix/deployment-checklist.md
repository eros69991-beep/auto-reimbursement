# 部署操作单（Railway + GitHub + Netlify）

按顺序执行，每步都有「操作」和「验证」。全程约 20–30 分钟。

---

## 第 0 步：准备

- 想好一个**访问码**（建议 12 位以上随机字符串，不要用生日/手机号）。这个码以后就是打开系统的唯一钥匙，只告诉要用的人。
- 本机装好 PowerShell 或 Git Bash（算哈希用）。

---

## 第 1 步：Railway 环境变量

**操作**：Railway 控制台 → 你的项目 → 后端服务 → **Variables**，新增以下 3 个变量：

| 变量名 | 值 | 说明 |
|---|---|---|
| `ACCESS_CODE_SHA256` | 第 0 步访问码的 SHA256（见下方命令） | 不存明文，只存哈希 |
| `TZ` | `Asia/Shanghai` | 报销日期按中国时区归属 |
| `REQUIRE_VOLUME` | `1` | 强制检测持久卷，没挂卷直接拒启动 |

算哈希（Git Bash 执行，把 `你的访问码` 替换掉，**注意 printf 不要换行**）：

```bash
printf '你的访问码' | sha256sum
```

输出第一列那串 64 位十六进制就是 `ACCESS_CODE_SHA256` 的值。

**验证**：变量保存后 Railway 会自动重新部署。部署完成后打开：

```
https://<你的railway域名>/api/health
```

- 不挂卷时服务应**启动失败**（这是故意的，见第 2 步），日志里能看到 REQUIRE_VOLUME 报错。
- 访问任何 `/api/receipts` 接口应返回 **401**（没带访问码），说明鉴权生效。

---

## 第 2 步：确认持久卷（Volume）

**操作**：

1. Railway 服务 → **Volumes** 页签，确认有一个 Volume 挂载到 `/app/data`。
2. 如果没有：**Add Volume** → Mount Path 填 `/app/data` → 保存。
3. 在卷上创建占位文件（防误挂空目录）。Railway 控制台打开服务的 Shell，执行：

```bash
touch /app/data/.volume-id
```

**验证**：重新部署后 `/api/health` 返回 200 且包含存储正常的字段；Railway 日志里**不再有** REQUIRE_VOLUME 报错。

> ⚠️ 没有 Volume 时 SQLite 数据库和凭证图片会在每次部署后丢失，所以 REQUIRE_VOLUME=1 会故意拒启动来提醒你。

---

## 第 3 步：GitHub 授权 Railway 自动部署

**操作**：

1. GitHub → 头像 → **Settings** → **Applications** → **GitHub Apps** → 找到 **Railway** → Configure。
2. 确认 `eros69991-beep/auto-reimbursement` 在授权仓库列表里；不在就加上。
3. Railway 项目 → **Settings** → **Source**，确认连接的是本仓库、分支是 `feature/mvp-implementation`，并开启自动部署（push 即部署）。

**验证**：随便推一个空提交（或看本次已推送的提交），Railway **Deployments** 页应自动出现一条新的部署记录且成功。

---

## 第 4 步：更换 Railway 域名

> 原因：访问码上线前，旧域名可能被无鉴权地访问/收录过，按已泄露处理。

**操作**：Railway 服务 → **Settings** → **Networking** → **Generate Domain** 生成新域名（或绑自定义域名），删除旧域名。

**验证**：浏览器打开**新**域名 `/api/health` 返回 200；旧域名无法访问。

---

## 第 5 步：核对前后端版本一致

**操作**：浏览器打开：

```
https://<新域名>/api/version
```

**验证**：返回 JSON 里的 `commit` 值，与 GitHub 上 `feature/mvp-implementation` 分支最新提交短哈希一致（当前应为 `050851c` 或更新）。前端页面底部/设置页显示的版本号也应一致。

---

## 第 6 步：存量数据体检

**操作**：在能连到 Railway 服务的环境（本地配好 `RAILWAY_TOKEN` 或用 Railway CLI shell）执行：

```bash
node scripts/audit-refunds.mjs
node scripts/audit-pending.mjs
```

**验证**：

- `audit-refunds`：检查退款金额 > 实付金额的脏数据，输出 0 条问题即正常；有问题按提示人工核对修正。
- `audit-pending`：检查卡在「识别中」状态的凭证，输出 0 条即正常；有卡住的按其 ID 在前端「待识别」里重试。

---

## 第 7 步：端到端冒烟（手机上做一遍）

用手机浏览器打开前端（Netlify 地址），完整走一遍：

1. 输入访问码 → 进入首页 ✅
2. 上传 1 张发票 → 识别出金额/商户/日期 ✅
3. 改一下商户名 → 切到别的页面再回来 → 修改还在 ✅
4. 生成报销单 PDF → 打开预览，行线不压字、金额大写正确 ✅
5. 撤销这批 → 凭证回到报销池 ✅

全部通过 = 部署完成 🎉

---

## 出问题怎么办

| 现象 | 先看哪里 |
|---|---|
| 服务起不来 | Railway 日志 → 多半是 Volume 没挂或变量没设 |
| 401 一直拒绝 | `ACCESS_CODE_SHA256` 算错了？确认是 `printf` 不带换行的哈希 |
| 日期差一天 | `TZ` 没设或没重新部署 |
| 前后端数据对不上 | `/api/version` 核对 commit，清浏览器缓存 |
| CI 红了 | GitHub Actions 页看失败步骤，本地 `pnpm typecheck && pnpm test` 复现 |
