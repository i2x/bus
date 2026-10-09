#!/bin/bash
# deploy จากเครื่องเรา → ruk-com
#   ค่าเริ่มต้น = 2 node บน ruk-com (ตั้งแต่ 9 ต.ค. 2569): web = node 89231 (Nginx) · api = node 89583 (Node.js + PostgreSQL)
#   ./deploy/deploy.sh
#   เครื่องเดียว:  API_HOST=$WEB_HOST API_ADDR=127.0.0.1 ./deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=3022
WEB_HOST=${WEB_HOST:-89231-126@gate.manage.ruk-com.cloud}
API_HOST=${API_HOST:-89583-126@gate.manage.ruk-com.cloud}
API_ADDR=${API_ADDR:-10.104.19.195}   # private IP ของ API node
WEB_ADDR=${WEB_ADDR:-10.104.11.4}     # private IP ของ web node (ต่อ API ได้เครื่องเดียว)
if [ "$API_HOST" != "$WEB_HOST" ]; then
  [ "$API_ADDR" != 127.0.0.1 ] && [ -n "$WEB_ADDR" ] || { echo "แยก node ต้องใส่ API_ADDR และ WEB_ADDR (private IP)"; exit 1; }
  SPLIT=1
else SPLIT=0; fi
ssh_() { local h=$1; shift; ssh -p $PORT "$h" "$@"; }
put() { rsync -az --delete --exclude .DS_Store -e "ssh -p $PORT" "$@"; }

# ---------- app + data tier ----------
if [ $SPLIT = 1 ]; then
  ssh_ "$API_HOST" "ROLE=api API_BIND=$API_ADDR ALLOW_FROM=$WEB_ADDR bash -s" < deploy/server-setup.sh
  ssh_ "$WEB_HOST" "ROLE=web bash -s" < deploy/server-setup.sh
else
  ssh_ "$API_HOST" "ROLE=all bash -s" < deploy/server-setup.sh
fi
put --exclude node_modules --exclude test.js api/ "$API_HOST:/opt/bus-api/"
put data.js "$API_HOST:/opt/bus-api/data.js"
put deploy/bus-api.service deploy/bus-backup.service deploy/bus-backup.timer "$API_HOST:/etc/systemd/system/"
put deploy/bus-backup.sh deploy/bus-restore-test.sh "$API_HOST:/usr/local/sbin/"
ssh_ "$API_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
export PATH=/usr/local/bin:$PATH
cd /opt/bus-api
npm ci --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:root /opt/bus-api
runuser -u busapi -- bash -c 'set -a; . /etc/bus-api.env; /usr/local/bin/node db-init.js'
systemctl daemon-reload
systemctl enable bus-api bus-backup.timer >/dev/null 2>&1
systemctl restart bus-api
systemctl start bus-backup.timer
REMOTE

# ---------- web tier ----------
[ -d node_modules ] || npm install --silent
npm run --silent build:css
put index.html privacy.html data.js app.css sw.js manifest.webmanifest "$WEB_HOST:/var/www/bus/"
put icons/ "$WEB_HOST:/var/www/bus/icons/"
put stickers/ "$WEB_HOST:/var/www/bus/stickers/"
put avatars/ "$WEB_HOST:/var/www/bus/avatars/"
put pitch/ "$WEB_HOST:/var/www/bus/pitch/"
put deploy/nginx-bus.conf "$WEB_HOST:/etc/nginx/sites-available/bus"
put deploy/bus-headers.conf "$WEB_HOST:/etc/nginx/snippets/bus-headers.conf"
sed "s|127.0.0.1:3000|$API_ADDR:3000|" deploy/bus-proxy.conf | ssh_ "$WEB_HOST" 'cat > /etc/nginx/snippets/bus-proxy.conf'
ssh_ "$WEB_HOST" "API_ADDR=$API_ADDR bash -s" <<'REMOTE'
set -euo pipefail
chown -R root:root /var/www/bus
# เปลี่ยน nginx จาก default → bus (สำรองของเดิมไว้ครั้งแรก, ไฟล์ใน /var/www/html ไม่ถูกแตะ)
[ -e /root/nginx-default.before-bus ] || [ ! -e /etc/nginx/sites-available/default ] || cp -a /etc/nginx/sites-available/default /root/nginx-default.before-bus
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/bus /etc/nginx/sites-enabled/bus
nginx -t -q && systemctl reload nginx

sleep 1
curl -fsS "http://$API_ADDR:3000/api/health" && echo
curl -fsS -o /dev/null -w "nginx / → %{http_code}\n" http://127.0.0.1/
curl -fsS -o /dev/null -w "nginx /api/health → %{http_code}\n" http://127.0.0.1/api/health
REMOTE
