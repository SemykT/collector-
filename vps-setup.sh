#!/usr/bin/env bash
# Установка whale-collector на чистый VPS (Ubuntu / Debian).
#
# Запуск от root:
#   bash vps-setup.sh
# С Cloudflare-туннелем (токен из Zero Trust -> Networks -> Tunnels):
#   CF_TOKEN=xxxxx bash vps-setup.sh
#
# Скрипт можно запускать повторно: он обновит код и не затрёт настройки.
set -euo pipefail

REPO="https://github.com/SemykT/collector-.git"
APP_USER="collector"
BASE="/opt/collector"
APP_DIR="$BASE/app"
DATA_DIR="$BASE/data"
BACKUP_DIR="$BASE/backups"

[ "$(id -u)" -eq 0 ] || { echo "Запусти от root"; exit 1; }

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

echo "==> Пакеты"
apt-get update
apt-get -y -o Dpkg::Options::=--force-confold upgrade
apt-get install -y git curl xz-utils sqlite3 ufw cron ca-certificates

echo "==> Node.js 22"
need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -ge 22 ]; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  case "$(uname -m)" in
    x86_64)  NARCH=x64 ;;
    aarch64) NARCH=arm64 ;;
    *) echo "Неизвестная архитектура: $(uname -m)"; exit 1 ;;
  esac
  NBASE="https://nodejs.org/dist/latest-v22.x"
  curl -fsSL "$NBASE/SHASUMS256.txt" -o /tmp/node-sums.txt
  NFILE=$(grep -o "node-v[0-9.]*-linux-${NARCH}\.tar\.xz" /tmp/node-sums.txt | head -n1)
  curl -fsSL "$NBASE/$NFILE" -o "/tmp/$NFILE"
  (cd /tmp && grep " $NFILE\$" node-sums.txt | sha256sum -c -)
  tar -xJf "/tmp/$NFILE" -C /usr/local --strip-components=1 --no-same-owner
  rm -f "/tmp/$NFILE" /tmp/node-sums.txt
fi
echo "Node: $(node -v)"

echo "==> Пользователь и папки"
mkdir -p "$BASE" "$DATA_DIR" "$BACKUP_DIR"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$BASE" --shell /usr/sbin/nologin "$APP_USER"
fi
chown -R "$APP_USER:$APP_USER" "$BASE"

as_app() { runuser -u "$APP_USER" -- env HOME="$BASE" "$@"; }

echo "==> Код из GitHub"
if [ -d "$APP_DIR/.git" ]; then
  as_app git -C "$APP_DIR" pull --ff-only
else
  as_app git clone "$REPO" "$APP_DIR"
fi

# Перенос истории: положи data.db (и data.db-wal / data.db-shm, если есть)
# в /root/ до запуска скрипта. Существующую базу на сервере не затираем.
if [ -f /root/data.db ] && [ ! -f "$DATA_DIR/data.db" ]; then
  echo "==> Переношу data.db с телефона"
  mv /root/data.db* "$DATA_DIR/"
  chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
fi

echo "==> Настройки (/etc/collector.env)"
if [ ! -f /etc/collector.env ]; then
  cat > /etc/collector.env <<EOF
PORT=8080
TOP=60
COINS=BTC,ETH,ZEC
MIN_BIG=10000
DB=$DATA_DIR/data.db
EOF
fi
chown root:"$APP_USER" /etc/collector.env
chmod 640 /etc/collector.env

echo "==> Служба systemd"
cat > /etc/systemd/system/collector.service <<EOF
[Unit]
Description=Whale collector (Hyperliquid)
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/collector.env
ExecStart=/usr/local/bin/node --no-warnings server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

echo "==> Команда обновления: collector-update"
cat > /usr/local/bin/collector-update <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
runuser -u collector -- env HOME=/opt/collector git -C /opt/collector/app pull --ff-only
systemctl restart collector
systemctl --no-pager --lines=5 status collector || true
EOF
chmod +x /usr/local/bin/collector-update

echo "==> Ежедневный бэкап базы (хранятся 3 последних)"
cat > /usr/local/bin/collector-backup <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DB=/opt/collector/data/data.db
OUT=/opt/collector/backups
[ -f "$DB" ] || exit 0
TMP="$OUT/data-$(date +%F).db"
sqlite3 "$DB" ".backup '$TMP'"
gzip -f "$TMP"
find "$OUT" -name 'data-*.db.gz' -mtime +3 -delete
EOF
chmod +x /usr/local/bin/collector-backup
echo '0 4 * * * collector /usr/local/bin/collector-backup' > /etc/cron.d/collector-backup
chmod 644 /etc/cron.d/collector-backup

echo "==> Файрвол (наружу только SSH)"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw --force enable

echo "==> Запуск"
systemctl daemon-reload
systemctl enable --now collector
sleep 3
systemctl --no-pager --lines=8 status collector || true

echo "==> cloudflared"
if ! command -v cloudflared >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64)  CARCH=amd64 ;;
    aarch64) CARCH=arm64 ;;
    *) echo "Неизвестная архитектура для cloudflared"; exit 1 ;;
  esac
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CARCH}.deb" -o /tmp/cloudflared.deb
  dpkg -i /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
fi
if [ -n "${CF_TOKEN:-}" ]; then
  cloudflared service install "$CF_TOKEN" || echo "Служба cloudflared уже установлена или токен не подошёл."
else
  echo "cloudflared установлен, но туннель не подключён (не передан CF_TOKEN)."
fi

cat <<EOF

Готово.
  Логи:        journalctl -u collector -f
  Проверка:    curl -i http://localhost:8080/
  Обновить код (после правок на GitHub):  collector-update
  Настройки:   nano /etc/collector.env  ->  systemctl restart collector
  Диск:        df -h  и  du -sh $DATA_DIR
EOF
