---
name: deploy-gamepulse
description: 构建并部署 GamePulse 到腾讯云生产环境 gp.yumi0606.top。当用户要求部署、上线、发布最新改动、构建并推送到服务器时使用。不用于纯本地构建或只查看服务器日志。
---

# 部署 GamePulse 到腾讯云

将本仓库最新代码构建后部署到腾讯云服务器（SSH 别名 `tencent`），生产域名 https://gp.yumi0606.top。

部署前如遇流程外的异常（依赖新增失败、服务反复重启、数据库报错），先停下排查并告知用户，不要带病继续。

## 环境事实（已验证，勿凭空改动）

- SSH：`ssh tencent`（本机已配置别名与密钥）；终端 PowerShell，禁止用 Linux 命令。
- 服务器代码目录：`/opt/gamepulse`；SQLite 数据库：`/opt/gamepulse/data/feed.db`；落盘日志：`/opt/gamepulse/logs/app.log`。
- 服务器 Node：`/www/server/nodejs/v24.14.0/bin`（非登录 shell 不在 PATH，需显式 `export PATH=$PATH:/www/server/nodejs/v24.14.0/bin:/usr/local/bin`）；包管理器 pnpm。
- 组件形态：
  - 主服务（web + 调度管道）：systemd 单元 `gamepulse-web`，监听 `127.0.0.1:3100`。
  - OCR 侧车：systemd 单元 `gamepulse-ocr`，监听 `127.0.0.1:1225`。
  - RSSHub：docker 容器 `rsshub`，`127.0.0.1:1200`，Cookie 走 `--env-file /opt/gamepulse/bili-cookie.env`。
  - nginx 由宝塔管理，vhost：`/www/server/panel/vhost/nginx/gp.yumi0606.top.conf`，反代到 3100。

## 标准部署流程

### 1. 确认更新范围

- `git status --short` 与近期提交，判断是否有新增依赖（看 package.json diff）。
- 确认是否新增非 ts 静态资源：tsc 只编译 .ts，资源文件必须靠 src 目录一起上传（日历资源运行时从 `src/web/assets/` 读取）。

### 2. 本地构建并打包

```powershell
pnpm build
# 构建成功后打包：dist（编译产物）+ src（含 assets 等非 ts 资源）+ 依赖清单
tar -czf "$env:TEMP\gamepulse-dist.tar.gz" dist src package.json pnpm-lock.yaml
```

`pnpm build`（tsc）是第一道兜底，失败即停止，不上传。

### 3. 上传并在服务器解压

```powershell
scp "$env:TEMP\gamepulse-dist.tar.gz" tencent:/tmp/
ssh tencent 'cd /opt/gamepulse && tar -xzf /tmp/gamepulse-dist.tar.gz'
```

### 4. 同步依赖（有新依赖时必须，无变化也可安全执行）

```powershell
ssh tencent 'cd /opt/gamepulse && export PATH=$PATH:/www/server/nodejs/v24.14.0/bin:/usr/local/bin && pnpm install 2>&1 | tail -3'
```

### 5. .env 处理

- 默认**不要**用本地 .env 覆盖服务器配置，除非用户明确要求（如"把开发环境的 .env 也上线"）。
- 需要上线本地 .env 时，上传后必须做两处服务器专属适配：
  - `RSSHUB_BASE` 改为 `http://127.0.0.1:1200`（`localhost` 可能解析成 IPv6，连不上 docker 的 IPv4 端口）。
  - `LOG_PRETTY=0`（日志采集需要 JSON 行，非美化格式）。
  - 同时 `chmod 600 /opt/gamepulse/.env`，并确保 `mkdir -p /opt/gamepulse/logs`（配置了 LOG_FILE 时）。

### 6. 重启主服务并验证

```powershell
ssh tencent 'systemctl restart gamepulse-web; sleep 8; systemctl is-active gamepulse-web'
```

注意：仅当改动涉及 `ocr-service/`（Python 侧）才重启 `gamepulse-ocr`；仅当改了 nginx vhost 才 `nginx -t && nginx -s reload`。

### 7. 部署后验证清单（逐项确认）

```powershell
ssh tencent 'curl -s -o /dev/null -w "home:%{http_code}\n" https://gp.yumi0606.top/;
curl -s -o /dev/null -w "calendar:%{http_code}\n" https://gp.yumi0606.top/calendar;
tail -5 /opt/gamepulse/logs/app.log'
```

- 首页、日历、（如改动涉及）静态资源 `/assets/*`、RSS 路径均返回 200。
- 落盘日志中调度器首轮同步正常：无 ERROR，拉取/OCR/LLM 各阶段符合预期。
- 改动涉及前端页面时，可用浏览器打开 https://gp.yumi0606.top 目检。

向用户报告时给出：部署的提交/内容、服务状态、各端点验证结果、首轮同步数据。

## 历史踩坑（避免重复）

- 建表 SQL 注释里写过字面量 `\n`，在 JS 模板字符串中被解析成真实换行，截断 `--` 注释导致列名错乱。SQL 注释中禁止出现转义序列。
- OCR 环境变量名是 `OCR_SERVICE_URL`（src/processing/ocr.ts 读取），不是 `OCR_BASE`；默认端口 1225。
- B站动态路由必须配**完整 Cookie**（含 buvid3/buvid4 等设备指纹），只配 SESSDATA 会触发 412/-352 风控；更新 Cookie 后 `docker restart rsshub` 即可。
- OCR 侧车曾缺 `libGL.so.1`：无 GUI 服务器需用 `opencv-python-headless`。
- RSSHub 容器内 Playwright 浏览器缺失通常是 Cookie 失效的表象，先修 Cookie，不要试图在容器里装浏览器。
