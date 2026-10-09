#!/bin/bash
# ใส่ค่า LINE Messaging API ลง /etc/bus-api.env บน server แล้ว restart API:  ./deploy/set-line.sh
# พิมพ์ค่าเอง ไม่แสดงบนจอ ไม่อยู่ใน history ไม่ส่งผ่าน argument ของ ssh
set -euo pipefail
API_HOST=${API_HOST:-89231-126@gate.manage.ruk-com.cloud}
read -rsp "Channel secret (แท็บ Basic settings): " SECRET; echo
read -rsp "Channel access token (แท็บ Messaging API): " TOKEN; echo
read -rp  "Bot basic ID เช่น @123abcde: " BOT
[ -n "$SECRET" ] && [ -n "$TOKEN" ] && [[ "$BOT" == @* ]] || { echo "ค่าไม่ครบ หรือ Bot ID ไม่ขึ้นต้นด้วย @"; exit 1; }
printf 'LINE_CHANNEL_SECRET=%s\nLINE_CHANNEL_ACCESS_TOKEN=%s\nLINE_BOT_ID=%s\n' "$SECRET" "$TOKEN" "$BOT" |
ssh -p 3022 "$API_HOST" 'set -e; f=/etc/bus-api.env; t=$(mktemp); grep -v "^LINE_\(CHANNEL_SECRET\|CHANNEL_ACCESS_TOKEN\|BOT_ID\)=" "$f" > "$t" || true; cat >> "$t"; cat "$t" > "$f"; rm -f "$t"; systemctl restart bus-api; sleep 2; systemctl is-active bus-api'
curl -s https://env-0241390.proen.app.ruk-com.cloud/api/config; echo
