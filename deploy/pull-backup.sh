#!/bin/bash
# ดึง backup จาก server มาเก็บนอกเครื่อง (./backups ไม่อยู่ใน git):  ./deploy/pull-backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
API_HOST=${API_HOST:-89231-126@gate.manage.ruk-com.cloud}
mkdir -p backups
rsync -az -e "ssh -p 3022" "$API_HOST:/var/backups/bus/" backups/
ls -lh backups | tail -3
