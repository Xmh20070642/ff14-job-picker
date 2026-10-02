#!/usr/bin/env bash
# 开机自启动卸载脚本 v2
cd "$(dirname "$0")"

PLIST="$HOME/Library/LaunchAgents/com.job-randomizer.v2.plist"

echo "========================================"
echo "  职业随机选择器 v2 - 卸载开机自启"
echo "========================================"

if [ -f "$PLIST" ]; then
  echo "🛑 停止服务并移除自启动配置…"
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "✅ 已卸载"
else
  echo "ℹ️  未找到自启动配置"
fi

pkill -f "node.*ff14-job-picker/server.js" 2>/dev/null && echo "已停止运行中的服务" || echo "（无运行中的服务）"

echo ""
echo "数据文件 $(pwd)/data/jobs.db 仍保留。"
echo ""
read -p "按回车关闭" _
