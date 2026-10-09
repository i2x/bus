#!/bin/bash
# ติดตั้งบนเครื่อง (Ubuntu 24.04, รันเป็น root) — รันซ้ำได้
# ROLE=all (เครื่องเดียว) | web (Nginx) | api (Node + PostgreSQL)
# API_BIND = address ที่ API ฟัง (เครื่องเดียว 127.0.0.1 · แยก node = private IP ของ API node)
# ALLOW_FROM = IP ของ web node ที่ยอมให้ต่อ API (เฉพาะแยก node)
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
ROLE=${ROLE:-all}
API_BIND=${API_BIND:-127.0.0.1}
ALLOW_FROM=${ALLOW_FROM:-}

pkgs=()
[ "$ROLE" != api ] && ! command -v nginx >/dev/null && pkgs+=(nginx)
[ "$ROLE" != web ] && ! command -v psql >/dev/null && pkgs+=(postgresql)
command -v xz >/dev/null || pkgs+=(xz-utils)
command -v curl >/dev/null || pkgs+=(curl)
[ ${#pkgs[@]} -gt 0 ] && { apt-get update -qq; apt-get install -y -qq "${pkgs[@]}" >/dev/null; }

if [ "$ROLE" != api ]; then
  mkdir -p /var/www/bus
fi
[ "$ROLE" = web ] && { echo "setup ok (web): $(nginx -v 2>&1)"; exit 0; }

# Node 22 LTS จาก nodejs.org (Ubuntu ให้แค่ 18 ที่หมดซัพพอร์ตแล้ว) · ตรวจ SHA256 ก่อนติดตั้ง
node_major() { /usr/local/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  case "$(uname -m)" in x86_64) a=x64 ;; aarch64) a=arm64 ;; *) echo "unsupported arch"; exit 1 ;; esac
  base=https://nodejs.org/dist/latest-v22.x
  tmp=$(mktemp -d)
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  f=$(grep -oE "node-v22\.[0-9.]+-linux-$a\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)
  curl -fsSL "$base/$f" -o "$tmp/$f"
  (cd "$tmp" && grep " $f\$" SHASUMS256.txt | sha256sum -c --quiet -)
  tar -xJf "$tmp/$f" -C /usr/local --strip-components=1 --exclude='*.md' --exclude=LICENSE
  rm -rf "$tmp"
fi
systemctl enable --now postgresql >/dev/null

# ผู้ใช้ระบบสำหรับรัน API (ไม่มี shell, ไม่ใช่ root) · ต่อ DB ผ่าน unix socket แบบ peer auth → ไม่ต้องมีรหัสผ่าน DB
id busapi >/dev/null 2>&1 || useradd --system --home-dir /opt/bus-api --shell /usr/sbin/nologin busapi
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='busapi'" | grep -q 1 || runuser -u postgres -- createuser busapi
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='bus'" | grep -q 1 || runuser -u postgres -- createdb -O busapi bus

ENV=/etc/bus-api.env
if [ ! -f $ENV ]; then
  printf 'DATABASE_URL=postgresql:///bus?host=/var/run/postgresql\nJWT_SECRET=%s\nPORT=3000\nNODE_ENV=production\n' "$(openssl rand -hex 32)" > $ENV
fi
setenv() { grep -q "^$1=" $ENV && sed -i "s|^$1=.*|$1=$2|" $ENV || echo "$1=$2" >> $ENV; }
setenv HOST "$API_BIND"
setenv ALLOW_FROM "$ALLOW_FROM"
setenv TRUST_PROXY "${ALLOW_FROM:-loopback}"
# ลูกขุน: เดโมใช้บัญชีทดสอบที่เพิ่งสมัคร → ไม่จำกัดอายุบัญชี (ใช้จริงลบบรรทัดนี้ ค่าเริ่ม = 7 วัน)
grep -q '^JURY_MIN_AGE_DAYS=' $ENV || echo 'JURY_MIN_AGE_DAYS=0' >> $ENV
chown root:busapi $ENV; chmod 640 $ENV

# แยก node: พอร์ต 3000 รับจาก web node เท่านั้น (API เช็ก ALLOW_FROM ซ้ำอีกชั้น) · 5432 ฟังแค่ localhost อยู่แล้ว
# กฎ iptables หายเมื่อเครื่อง restart → เขียนเป็นสคริปต์ + systemd unit ที่รันก่อน bus-api ทุกครั้งที่บูต
if [ -n "$ALLOW_FROM" ] && command -v iptables >/dev/null; then
  cat > /usr/local/sbin/bus-fw.sh <<FW
#!/bin/bash
set -e
iptables -N BUS_API 2>/dev/null || iptables -F BUS_API
iptables -A BUS_API -s $ALLOW_FROM -j ACCEPT
iptables -A BUS_API -s 127.0.0.1 -j ACCEPT
iptables -A BUS_API -j DROP
iptables -C INPUT -p tcp --dport 3000 -j BUS_API 2>/dev/null || iptables -I INPUT -p tcp --dport 3000 -j BUS_API
FW
  chmod 700 /usr/local/sbin/bus-fw.sh
  cat > /etc/systemd/system/bus-fw.service <<'UNIT'
[Unit]
Description=bus API firewall (port 3000 from web node only)
Before=bus-api.service
After=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/bus-fw.sh

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable bus-fw >/dev/null 2>&1
  systemctl restart bus-fw || echo "warn: ตั้ง iptables ไม่ได้ในเครื่องนี้ — เหลือ ALLOW_FROM ใน API อีกชั้น"
elif [ -n "$ALLOW_FROM" ]; then
  echo "warn: ไม่มี iptables — เหลือ ALLOW_FROM ใน API อีกชั้น"
fi

mkdir -p /opt/bus-api /var/backups/bus
chmod 700 /var/backups/bus
echo "setup ok ($ROLE): node $(/usr/local/bin/node -v), $(psql --version)"
