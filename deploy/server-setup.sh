#!/bin/bash
# ติดตั้งครั้งแรกบนเครื่อง (Ubuntu 24.04, รันเป็น root) — รันซ้ำได้
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

command -v node >/dev/null && command -v psql >/dev/null || { apt-get update -qq; apt-get install -y -qq nodejs npm postgresql >/dev/null; }
systemctl enable --now postgresql >/dev/null

# ผู้ใช้ระบบสำหรับรัน API (ไม่มี shell, ไม่ใช่ root) · ต่อ DB ผ่าน unix socket แบบ peer auth → ไม่ต้องมีรหัสผ่าน DB
id busapi >/dev/null 2>&1 || useradd --system --home-dir /opt/bus-api --shell /usr/sbin/nologin busapi
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='busapi'" | grep -q 1 || runuser -u postgres -- createuser busapi
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='bus'" | grep -q 1 || runuser -u postgres -- createdb -O busapi bus

if [ ! -f /etc/bus-api.env ]; then
  printf 'DATABASE_URL=postgresql:///bus?host=/var/run/postgresql\nJWT_SECRET=%s\nHOST=127.0.0.1\nPORT=3000\nNODE_ENV=production\n' "$(openssl rand -hex 32)" > /etc/bus-api.env
  chown root:busapi /etc/bus-api.env; chmod 640 /etc/bus-api.env
fi

mkdir -p /opt/bus-api /var/www/bus
echo "setup ok: node $(node -v), $(psql --version)"
