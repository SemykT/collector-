#!/data/data/com.termux/files/usr/bin/bash
# Установка сборщика на Android (Termux). Запуск: bash termux-setup.sh
set -e
cd "$(dirname "$0")"
echo "== 1/5 Пакеты =="
pkg update -y
pkg install -y nodejs cloudflared curl git procps

echo "== 2/5 Проверка Node =="
node -v
node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)" \
  || { echo "ОШИБКА: нужен Node 22.13+"; exit 1; }
node -e "require('node:sqlite')" 2>/dev/null \
  || { echo "ОШИБКА: в этой сборке Node нет встроенного sqlite (node:sqlite). Напишите об этом в чат."; exit 1; }
echo "Node и sqlite в порядке"

echo "== 3/5 Настройка =="
if [ -f .env ]; then
  echo "Файл .env уже есть, оставляю как есть (чтобы изменить, удалите его и запустите скрипт заново)"
else
  read -r -p "Адрес вашего сайта на Vercel (например https://moy-sait.vercel.app): " SITE
  read -r -p "Секрет (то же значение, что COLLECTOR_SECRET в Vercel): " SECRET
  SITE="${SITE%/}"
  printf "SITE='%s'\nSECRET='%s'\n" "$SITE" "$SECRET" > .env
fi
mkdir -p data
chmod +x termux-run.sh 2>/dev/null || true

echo "== 4/5 Автозапуск после перезагрузки телефона (нужно приложение Termux:Boot) =="
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/collector.sh" <<BOOT
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
cd "$PWD" && nohup bash termux-run.sh >> data/run.log 2>&1 &
BOOT
chmod +x "$HOME/.termux/boot/collector.sh"

echo "== 5/5 Запуск =="
termux-wake-lock 2>/dev/null || true
nohup bash termux-run.sh >> data/run.log 2>&1 &
echo "Запущено. Жду 25 секунд..."
sleep 25
tail -n 8 data/run.log || true
curl -s http://127.0.0.1:8080/health || echo "(сервер ещё не ответил, повторите: curl http://127.0.0.1:8080/health)"
echo
echo "Остановить: bash termux-stop.sh   Лог: tail -f data/run.log"
