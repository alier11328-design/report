#!/usr/bin/env bash
# ============================================================
# 万能班长报告工坊 · 阿里云 ECS Nginx 反代安装脚本
# 用法：在服务器上执行   bash nginx.sh（需先跑完 deploy.sh）
# 功能：装 Nginx → 配置反代 80 → 127.0.0.1:3000 → 重启
# 说明：自动检测 CentOS / Ubuntu
# ============================================================
set -e

. /etc/os-release 2>/dev/null || { echo "❌ 无法读取 /etc/os-release"; exit 1; }

if command -v apt-get >/dev/null 2>&1; then
    PKG="apt"
elif command -v yum >/dev/null 2>&1; then
    PKG="yum"
else
    echo "❌ 未检测到 apt-get 或 yum，无法自动安装 Nginx"
    exit 1
fi
echo "包管理器：$PKG"

# ---------- 1. 安装 Nginx ----------
if command -v nginx >/dev/null 2>&1; then
    echo "✓ Nginx 已安装（$(nginx -v 2>&1)）"
else
    echo "▶ 正在安装 Nginx ..."
    if [ "$PKG" = "apt" ]; then
        apt-get update -y && apt-get install -y nginx
    else
        yum install -y nginx
    fi
fi

# ---------- 2. 移除 Ubuntu 默认站点（避免占用 80 端口） ----------
if [ "$PKG" = "apt" ]; then
    rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
    echo "✓ 已移除 Ubuntu 默认站点"
fi

# ---------- 3. 写入反向代理配置 ----------
CONF=/etc/nginx/conf.d/report.conf
cat > "$CONF" << 'EOF'
server {
    listen 80;
    server_name _;

    # 允许大文件上传（PDF/图片），默认 1m 会导致 413
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        # AI 识别耗时较长，放宽超时
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF
echo "✓ 配置已写入 $CONF"

# ---------- 4. 测试并重启 Nginx ----------
nginx -t
systemctl enable nginx
systemctl restart nginx

# ---------- 5. 放行服务器内部防火墙 80 端口（若防火墙开启） ----------
if command -v firewall-cmd >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port=80/tcp >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
    echo "✓ firewalld 已放行 80 端口"
elif command -v ufw >/dev/null 2>&1; then
    ufw allow 80/tcp >/dev/null 2>&1 || true
    echo "✓ ufw 已放行 80 端口"
fi

echo ""
echo "======================================"
echo "✅ Nginx 反代配置完成！"
echo "现在访问：http://你的服务器公网IP/ 即可（无需端口号）"
echo ""
echo "⚠️  记得在阿里云安全组放行 80 端口（入方向，0.0.0.0/0）"
echo "    如果之前只放行了 3000，现在还需额外放行 80"
echo ""
echo "本地验证：curl http://127.0.0.1/api/health"
