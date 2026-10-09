#!/bin/bash
# ใส่ค่า LINE Login channel ลง /etc/bus-api.env บน server แล้ว restart API:  ./deploy/set-line-login.sh
# พิมพ์ค่าเอง secret ไม่แสดงบนจอ ไม่อยู่ใน history ไม่ส่งผ่าน argument ของ ssh
set -euo pipefail
API_HOST=${API_HOST:-89583-126@gate.manage.ruk-com.cloud}
read -rp  "LINE Login Channel ID (ตัวเลข): " ID
read -rsp "LINE Login Channel secret (32 ตัว): " SECRET; echo
[[ "$ID" =~ ^[0-9]+$ ]] && [[ "$SECRET" =~ ^[0-9a-f]{32}$ ]] || { echo "Channel ID ต้องเป็นตัวเลข · secret ต้องเป็น 0-9 a-f 32 ตัว (กดปุ่ม copy ใน LINE Developers)"; exit 1; }
printf 'LINE_LOGIN_CHANNEL_ID=%s\nLINE_LOGIN_CHANNEL_SECRET=%s\n' "$ID" "$SECRET" |
ssh -p 3022 "$API_HOST" 'set -e; f=/etc/bus-api.env; t=$(mktemp); grep -v "^LINE_LOGIN_CHANNEL_\(ID\|SECRET\)=" "$f" > "$t" || true; cat >> "$t"; cat "$t" > "$f"; rm -f "$t"; systemctl restart bus-api; sleep 2; systemctl is-active bus-api'
curl -s https://env-0241390.proen.app.ruk-com.cloud/api/config; echo
