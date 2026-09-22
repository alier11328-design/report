# 部署说明（Cloudflare Pages）

本项目**只使用 Cloudflare Pages 一条部署链路**。
（原先的 Vercel / Netlify / 腾讯云 EdgeOne / Docker / Nginx 链路已于 2026-09-22 全部移除，如需回溯可从 Git 历史里取回。）

---

## 线上环境

| 项 | 值 |
|---|---|
| Cloudflare Pages 项目 | `classbroreport` |
| 生产地址 | https://classbroreport.pages.dev |
| 生产分支 | `main` |
| GitHub 仓库 | `alier11328-design/report` |
| 构建命令 | 空（不执行构建） |
| 输出目录 | 空（仓库根目录） |
| 部署方式 | Git 集成，push 到 `main` 自动触发 |

---

## 架构

```
浏览器
  │
  ├── 静态页面   index.html / course-plan.html / social-poster.html / …
  │   （由 Cloudflare Pages 的 CDN 直接托管）
  │
  └── /api/*  ──►  functions/api/**   （Cloudflare Pages Functions，同源，无需 CORS）
                    ├── /api/health                     → functions/api/health.js
                    ├── /api/ai/poster-caption           → functions/api/ai/poster-caption.js
                    ├── /api/ai/course-plan              → functions/api/ai/course-plan.js
                    ├── …（共 11 个 AI 接口）
                    └── /api/parse-file                  → functions/api/parse-file.js
```

**关键约定**

- `functions/` 目录**必须放在仓库根目录**，Pages 会自动把它识别为 Functions，按文件路径映射路由（`functions/api/ai/poster-caption.js` → `/api/ai/poster-caption`）。
- `functions/` 下每个文件**必须完全自包含**——Cloudflare Functions **不能跨目录引用模块**。这是历史踩坑点，新增接口时请把依赖内联进去，不要在 `functions/` 里 `import` 其他目录的文件。
- 前端 `ai-client.js` 的 `apiBaseUrl` 默认为空字符串 = 同源，因此线上**不需要**配置 `window.__API_BASE__`。
- AI 调用统一在 Functions 里用 `fetch` 直连火山方舟，**不使用 openai SDK / Node 专有库**（Workers 运行时限制）。PDF 解析在前端完成。

---

## 环境变量

在 **Cloudflare 控制台 → Workers & Pages → `classbroreport` → Settings → Variables and Secrets** 配置（Production 与 Preview 都要填）：

| 变量名 | 类型 | 说明 |
|---|---|---|
| `DASHSCOPE_API_KEY` | Secret | 火山方舟 API Key |
| `DASHSCOPE_BASE_URL` | Plain | `https://ark.cn-beijing.volces.com/api/plan/v3` |
| `DASHSCOPE_MODEL` | Plain | `doubao-seed-2-0-lite` |

⚠️ **改完环境变量必须重新部署一次才生效**（Pages 不会热更）。

---

## 日常发布流程

```bash
git add -A
git commit -m "feat: xxx"
git push origin main      # 推送到 main 即触发 Cloudflare 自动构建
```

无需任何额外命令，也无需构建产物。

### 新增页面注意

- HTML 页面直接放**仓库根目录**即可被托管，Pages 会自动识别。
- Cloudflare Pages 会把 `/xxx.html` **308 重定向**到干净路径 `/xxx`（例如 `index.html` → `/`、`social-poster.html` → `/social-poster`）。这是平台默认行为，浏览器会自动跟随，**不是 bug**；页面内的相对链接写 `xxx.html` 或 `xxx` 都能正常工作。

---

## 部署验证

### 1. 看构建状态

Cloudflare 控制台 → `classbroreport` → Deployments，看最新一条是否 `success`。

### 2. 线上接口自检

```bash
curl https://classbroreport.pages.dev/api/health
# 期望：{"ok":true,"model":"doubao-seed-2-0-lite","configured":true}
```

### 3. 线上页面自检

```bash
curl -L -o /dev/null -w "%{http_code}\n" https://classbroreport.pages.dev/social-poster
```

### 4. 排查线上函数

```bash
npx wrangler pages deployment tail --project-name classbroreport
```

在函数里加 `console.log` 就能在 tail 里看到，是线上排障最快的路径。
若本机有代理，先 `env -u HTTP_PROXY -u HTTPS_PROXY` 再跑，否则会 502 / 超时。

> **假 200 提醒**：新文件刚部署完，Pages 可能对不存在的路径兜底返回 `index.html`（200 但内容是 HTML）。
> 判断方法：看响应体开头是否为预期内容，或加个 `?v=随机` 参数再取一次。

---

## 本地开发

本地用自带的 Express 服务，**与线上部署无关**（`server.js` 是完全自包含的，内联了全部 13 个接口）：

```bash
npm install
npm start          # 或 npm run dev（--watch 热重载）
# http://localhost:3000
```

`.env`（本地，不提交）：

```env
DASHSCOPE_API_KEY=你的火山方舟API密钥
DASHSCOPE_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
DASHSCOPE_MODEL=doubao-seed-2-0-lite
PORT=3000
```

---

## 代码结构速查

| 路径 | 用途 |
|---|---|
| `functions/` | **线上后端**（Cloudflare Pages Functions，13 个接口，必须自包含） |
| `server.js` | 本地开发服务器（Express，与线上并行维护） |
| `ai-client.js` | 前端统一请求封装 |
| `tokens.css` | 设计令牌（含 `--poster-*` 海报主题变量） |
| `*.html` | 各工具页面，直接放根目录 |
| `scripts/` | 视觉校验工具（无头 Chrome + CDP，本地跑，不参与部署） |
| `change/`、`examples/` | 静态素材 |

> ⚠️ **改动接口时记得两边同步**：`functions/api/**`（线上）与 `server.js`（本地）。
> 两者是各自独立的实现，不会自动同步。

---

## 安全提示

⚠️ 上线前请注意：

- 本项目**没有登录鉴权和限流**，任何人拿到域名都能调用 AI 接口（会产生费用）。
- 建议加访问口令或在 Cloudflare 侧配置 WAF / Rate Limiting 规则。
- API Key 只放在 Cloudflare 环境变量里，**不要写进代码或提交到仓库**（`.env` 已在 `.gitignore` 中）。
