#!/usr/bin/env bash
# Instala Node, dependencias y el servicio systemd de Juan en Ubuntu (Oracle Cloud).
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/juan}"
SERVICE_NAME="juan"

if [[ $EUID -eq 0 ]]; then
  echo "No ejecutes este script como root. Entra como ubuntu y vuelve a correrlo."
  exit 1
fi

sudo apt-get update
sudo apt-get install -y ca-certificates curl xz-utils python3 build-essential ffmpeg

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -Eq '^v(1[8-9]|[2-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "Node $(node -v) / npm $(npm -v)"

cd "$APP_DIR"
if [[ ! -f package.json ]]; then
  echo "No encuentro package.json en $APP_DIR. Sube el proyecto primero."
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Falta $APP_DIR/.env con DISCORD_TOKEN y DISCORD_CLIENT_ID."
  exit 1
fi

sed -i 's/\r$//' .env
npm install
npx tsc
npm prune --omit=dev

sudo cp "$APP_DIR/deploy/juan.service" /etc/systemd/system/${SERVICE_NAME}.service
sudo sed -i "s|/home/ubuntu/juan|$APP_DIR|g" /etc/systemd/system/${SERVICE_NAME}.service
sudo sed -i "s|^User=ubuntu$|User=$USER|" /etc/systemd/system/${SERVICE_NAME}.service
sudo sed -i "s|^Group=ubuntu$|Group=$USER|" /etc/systemd/system/${SERVICE_NAME}.service

sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"

sleep 2
sudo systemctl --no-pager --full status "$SERVICE_NAME" || true
echo
echo "Logs en vivo: journalctl -u $SERVICE_NAME -f"
echo "Juan debería aparecer en línea en Discord en unos segundos."
