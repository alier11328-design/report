#!/usr/bin/env bash
# ============================================================
# 万能班长报告工坊 · 阿里云 ECS 一键部署脚本
# 用法：在项目根目录执行   bash deploy.sh
# 功能：装 Node20 + pm2 → 生成 .env → npm install → pm2 启动 → 健康检查
# 说明：脚本会自动检测 CentOS / Ubuntu，无需手动指定系统
# ============================================================
set -e

# 前置检查：必须在项目根目录执行
if [ ! -f server.js ] || [ ! -f package.json ]; then
    echo "❌ 请在项目根目录（含 server.js 和 package.json 的目录）执行本脚本"
    exit 1
fi

# 检测操作系统
. /etc/os-release 2>/dev/null || { echo "❌ 无法读取 /etc/os-release，请确认在 Linux 服务器上运行"; exit 1; }
echo "检测到系统：${PRETTY_NAME:-$ID}"

# ---------- 1. 安装 Node.js 20+（通过 nvm，跨系统通用） ----------
need_node=false
if ! command -v node >/dev/null 2>&1; then
    need_node=true
else
    node_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
    [ "$node_major" -lt 18 ] && need_node=true
fi

if [ "$need_node" = true ]; then
    echo "▶ 正在安装 Node.js 20（通过 nvm）..."
    if ! curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash; then
        echo "❌ 下载 nvm 失败（可能是访问 GitHub 缓慢）。"
        echo "   请改用系统包管理器手动安装 Node 20+ 后，重新执行本脚本。"
        exit 1
    fi
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    nvm install 20
    nvm alias default 20
    echo "✓ Node.js $(node -v) 安装完成"
else
    echo "✓ Node.js 已安装（$(node -v)）"
fi

# ---------- 2. 安装 pm2 ----------
if ! command -v pm2 >/dev/null 2>&1; then
    echo "▶ 正在安装 pm2 ..."
    npm install -g pm2
else
    echo "✓ pm2 已安装"
fi

# ---------- 3. 生成 .env（不存在或 key 为空时交互式输入） ----------
if [ -f .env ] && grep -q '^DASHSCOPE_API_KEY=.\+' .env; then
    echo "✓ .env 已存在且已配置 key"
else
    echo "▶ 请粘贴你的火山方舟 API Key（粘贴后回车，注意前后别带空格）："
    read -r API_KEY
    if [ -z "$API_KEY" ]; then
        echo "❌ API Key 不能为空，已取消。请手动创建 .env 后重跑本脚本。"
        exit 1
    fi
    cat > .env << EOF
HOST=0.0.0.0
PORT=3000
DASHSCOPE_API_KEY=$API_KEY
DASHSCOPE_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3
DASHSCOPE_MODEL=doubao-seed-2-0-lite
EOF
    echo "✓ .env 已生成"
fi

# ---------- 4. 安装依赖 ----------
echo "▶ 正在安装 npm 依赖（首次可能需要几分钟）..."
npm install

# ---------- 5. 用 pm2 启动（常驻后台，崩溃自动重启） ----------
pm2 delete report >/dev/null 2>&1 || true
pm2 start server.js --name report
pm2 save

# ---------- 6. 健康检查 ----------
sleep 2
echo ""
echo "======================================"
echo "健康检查结果（configured 应为 true）："
curl -s http://127.0.0.1:3000/api/health || echo "❌ 健康检查失败，请执行 pm2 logs report 查看日志"
echo ""
echo "======================================"
echo "✅ 部署完成！"
echo "下一步（在阿里云控制台操作）："
echo "  1. 安全组 → 入方向 → 放行 TCP 3000/3000，授权对象 0.0.0.0/0"
echo "  2. 浏览器访问：http://你的服务器公网IP:3000/index.html"
echo ""
echo "可选：开机自启（执行下面命令后，按提示复制它输出的那一行 sudo 命令运行）："
echo "  pm2 startup"
