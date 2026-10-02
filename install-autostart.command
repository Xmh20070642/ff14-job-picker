#!/usr/bin/env bash
# 开机自启动安装脚本 v2
set -e
cd "$(dirname "$0")"

PLIST="$HOME/Library/LaunchAgents/com.job-randomizer.v2.plist"

echo "========================================"
echo "  职业随机选择器 v2 - 开机自启安装"
echo "========================================"

# 依赖检查
if [ ! -d "node_modules" ]; then
  echo "📦 首次运行，安装依赖…"
  npm install
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ 未找到 node，请先安装 Node.js"
  read -p "按回车关闭" _
  exit 1
fi
# 解析符号链接，获取真实路径（避免 broken symlink）
NODE_BIN_REAL="$(readlink -f "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"
if [ -f "$NODE_BIN_REAL" ]; then
  NODE_BIN="$NODE_BIN_REAL"
fi

echo "📝 写入 launchd 配置: $PLIST"
echo "   node 路径: $NODE_BIN"
echo "   项目目录: $(pwd)"

mkdir -p logs

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.job-randomizer.v2</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$(pwd)/server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(pwd)</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$NODE_BIN"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
    <key>StandardOutPath</key>
    <string>$(pwd)/logs/launchd-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$(pwd)/logs/launchd-stderr.log</string>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
EOF

echo ""
echo "🚀 加载并启动服务…"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 2

if curl -sf -o /dev/null http://localhost:3000/api/state 2>/dev/null; then
  echo "✅ 服务已启动并运行中！"
else
  echo "⚠️  服务未能访问（可能端口 3000 被其他程序占用）"
  echo "    查看日志: tail -20 logs/launchd-stderr.log"
fi

LAN_IP=""
for iface in $(ifconfig 2>/dev/null | grep -oE '^[a-z0-9]+:' | tr -d ':'); do
  ip=$(ifconfig "$iface" 2>/dev/null | grep 'inet ' | awk '{print $2}')
  case "$ip" in
    127.*|::*|"") ;;
    *) LAN_IP="$ip" ;;
  esac
done

echo ""
echo "========================================"
echo "  ✅ 安装完成"
echo "========================================"
echo "本机访问:   http://localhost:3000"
[ -n "$LAN_IP" ] && echo "跨设备访问: http://$LAN_IP:3000"
echo ""
echo "每次开机/登录自动启动，无需任何操作。"
echo ""
read -p "按回车关闭" _
