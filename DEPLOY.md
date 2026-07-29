# 部署说明

## 架构说明

本项目是 Node.js Express 全栈应用，包含：
- **前端**：静态 HTML/JS 文件（index.html, final-report.html 等）
- **后端**：Node.js Express 服务器（server.js），处理 AI API 调用、文件解析等

### 部署方案

由于 **Cloudflare Workers 不支持 Node.js Express**，推荐以下两种部署方案：

---

## 方案 A：Cloudflare Pages（前端）+ Railway（后端）⭐推荐

### 第一步：部署后端到 Railway

Railway 是支持 Node.js 的 PaaS 平台，提供免费额度。

1. 访问 [https://railway.app](https://railway.app) 注册账号
2. 点击 **"New Project"** → **"Deploy from GitHub repo"**
3. 选择仓库 `alier11328-design/report`
4. 在项目设置中添加环境变量：
   ```
   DASHSCOPE_API_KEY=你的火山方舟API密钥
   DASHSCOPE_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
   DASHSCOPE_MODEL=doubao-seed-2-0-lite
   ```
5. Railway 会自动检测 Node.js 项目并部署
6. 部署完成后，复制后端服务的公网域名（如 `https://report.up.railway.app`）

### 第二步：部署前端到 Cloudflare Pages

1. 访问 [https://dash.cloudflare.com](https://dash.cloudflare.com) 登录
2. 进入 **Workers & Pages** → **Create** → **Pages**
3. 选择 **Connect to Git**，授权并选择仓库 `alier11328-design/report`
4. 构建配置：
   - **Build command**: 留空（不执行构建）
   - **Build output directory**: `.`（根目录）
5. 点击 **Save and Deploy**

### 第三步：配置前端连接后端

在 Cloudflare Pages 的前端代码中，需要设置 API 地址指向 Railway 后端。

在任意 HTML 文件的 `<head>` 中，在引入 `ai-client.js` 之前添加：

```html
<script>
    window.__API_BASE__ = 'https://你的Railway后端域名.up.railway.app';
</script>
```

或者直接修改 `ai-client.js` 第 8 行：
```javascript
let apiBaseUrl = window.__API_BASE__ || 'https://你的Railway后端域名.up.railway.app';
```

### 第四步：验证

- 访问 Cloudflare Pages 分配的域名
- 测试 AI 识别、文件上传等功能

---

## 方案 B：全栈部署到 Railway（最简单）

如果你不需要使用 Cloudflare，可以直接将整个项目部署到 Railway：

1. 访问 [https://railway.app](https://railway.app)
2. 点击 **"New Project"** → **"Deploy from GitHub repo"**
3. 选择仓库 `alier11328-design/report`
4. Railway 自动检测 Node.js 并部署
5. 添加环境变量（同上）
6. 访问 Railway 提供的公网域名

---

## 方案 C：Linux 服务器 + Nginx

### 1. 准备环境
- Node.js 20+
- Nginx
- PM2（进程管理）

### 2. 部署步骤

```bash
cd /var/www/report
git clone https://github.com/alier11328-design/report.git .
npm install
```

创建 `.env`：
```env
HOST=0.0.0.0
PORT=3000
DASHSCOPE_API_KEY=你的火山方舟API密钥
DASHSCOPE_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
DASHSCOPE_MODEL=doubao-seed-2-0-lite
```

启动服务：
```bash
npm install -g pm2
pm2 start server.js --name report
pm2 save
pm2 startup
```

### 3. 配置 Nginx

```nginx
server {
    listen 80;
    server_name 你的域名;
    
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

---

## 验证部署

访问 `https://你的域名/api/health`，应返回：

```json
{
  "ok": true,
  "model": "doubao-seed-2-0-lite",
  "configured": true
}
```

## 安全提示

⚠️ 生产部署前请注意：
- 本项目没有登录鉴权和限流
- API Key 直接暴露在后端代码中
- 建议添加访问密码或 API Key 验证
