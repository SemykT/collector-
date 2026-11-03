#!/data/data/com.termux/files/usr/bin/bash
# Запускает сборщик + туннель Cloudflare и публикует адрес туннеля на вашем сайте.
cd "$(dirname "$0")"
[ -f .env ] && . ./.env
mkdir -p data
if [ -f data/run.pid ] && kill -0 "$(cat data/run.pid)" 2>/dev/null; then echo "уже запущено"; exit 0; fi
echo $$ > data/run.pid
export DB="$PWD/data/data.db" PORT=8080
PORT=8080
termux-wake-lock 2>/dev/null

node_loop() {
  while true; do
    [ -f data/collector.log ] && [ "$(wc -c < data/collector.log)" -gt 5000000 ] && mv -f data/collector.log data/collector.old.log
    node --no-warnings server.js >> data/collector.log 2>&1
    sleep 5
  done
}
node_loop & NODE=$!
trap 'kill $NODE $CF 2>/dev/null; rm -f data/run.pid; exit 0' INT TERM

while true; do
  : > data/tunnel.log
  cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > data/tunnel.log 2>&1 &
  CF=$!
  URL=""
  for i in $(seq 1 60); do
    URL=$(grep -o 'https://[-a-z0-9]*\.trycloudflare\.com' data/tunnel.log | head -1)
    [ -n "$URL" ] && break
    kill -0 $CF 2>/dev/null || break
    sleep 1
  done
  if [ -z "$URL" ]; then echo "$(date) туннель не поднялся, повтор через 15 с"; kill $CF 2>/dev/null; sleep 15; continue; fi
  echo "$(date) туннель: $URL"
  bad=0
  while kill -0 $CF 2>/dev/null; do
    if [ -n "$SITE" ] && [ -n "$SECRET" ]; then
      if curl -fsS -m 20 -X POST "$SITE/api/collector" -H 'content-type: application/json' \
           -d "{\"url\":\"$URL\",\"secret\":\"$SECRET\"}" >/dev/null 2>>data/run.log; then wait_s=300; else echo "$(date) не удалось опубликовать адрес на сайте"; wait_s=30; fi
    else wait_s=300; fi
    # ждём, проверяя что туннель жив и отвечает
    for i in $(seq 1 $((wait_s/10))); do
      sleep 10
      kill -0 $CF 2>/dev/null || break
    done
    if curl -fsS -m 15 "$URL/health" >/dev/null 2>&1; then bad=0; else bad=$((bad+1)); fi
    if [ $bad -ge 3 ]; then echo "$(date) туннель не отвечает, перезапуск"; kill $CF 2>/dev/null; fi
  done
  sleep 5
done
