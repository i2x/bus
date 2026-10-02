#!/bin/bash
# deploy จากเครื่องเรา → ruk-com:  ./deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=3022
HOST=89231-126@gate.manage.ruk-com.cloud
SSH="ssh -p $PORT $HOST"
RSYNC="rsync -az --delete --exclude .DS_Store -e 'ssh -p $PORT'"

$SSH 'bash -s' < deploy/server-setup.sh

# web tier: static (สร้าง app.css จาก Tailwind ก่อน)
[ -d node_modules ] || npm install --silent
npm run --silent build:css
eval $RSYNC index.html data.js app.css "$HOST:/var/www/bus/"
eval $RSYNC pitch/ "$HOST:/var/www/bus/pitch/"
# app tier: API (+ data.js ชุดเดียวกับหน้าเว็บ)
eval $RSYNC --exclude node_modules api/ "$HOST:/opt/bus-api/"
eval rsync -az -e "'ssh -p $PORT'" data.js "$HOST:/opt/bus-api/data.js"
eval rsync -az -e "'ssh -p $PORT'" deploy/bus-api.service "$HOST:/etc/systemd/system/bus-api.service"
eval rsync -az -e "'ssh -p $PORT'" deploy/nginx-bus.conf "$HOST:/etc/nginx/sites-available/bus"
eval rsync -az -e "'ssh -p $PORT'" deploy/bus-proxy.conf "$HOST:/etc/nginx/snippets/bus-proxy.conf"

$SSH 'bash -s' <<'REMOTE'
set -euo pipefail
cd /opt/bus-api
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:root /opt/bus-api /var/www/bus
runuser -u busapi -- bash -c 'set -a; . /etc/bus-api.env; node db-init.js'
systemctl daemon-reload
systemctl enable bus-api >/dev/null 2>&1
systemctl restart bus-api

# เปลี่ยน nginx จาก default → bus (สำรองของเดิมไว้ครั้งแรก, ไฟล์ใน /var/www/html ไม่ถูกแตะ)
[ -e /root/nginx-default.before-bus ] || cp -a /etc/nginx/sites-available/default /root/nginx-default.before-bus
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/bus /etc/nginx/sites-enabled/bus
nginx -t -q && systemctl reload nginx

sleep 1
curl -fsS http://127.0.0.1:3000/api/health && echo
curl -fsS -o /dev/null -w "nginx / → %{http_code}\n" http://127.0.0.1/
REMOTE
