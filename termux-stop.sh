#!/data/data/com.termux/files/usr/bin/bash
cd "$(dirname "$0")"
[ -f data/run.pid ] && kill "$(cat data/run.pid)" 2>/dev/null
pkill -f "node --no-warnings server.js" 2>/dev/null
pkill cloudflared 2>/dev/null
rm -f data/run.pid
termux-wake-unlock 2>/dev/null
echo "остановлено"
