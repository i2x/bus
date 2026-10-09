# คันนี้ดีไหม? — ค้นหาและรีวิวรถเมล์ ขสมก. รายคัน

กรอกหมายเลขข้างรถ เช่น `7-3077` หรือ `2-70235` แล้วดูยี่ห้อ/รุ่น สีรถ ปีที่เริ่มให้บริการ เขตการเดินรถ อู่
อัตราค่าโดยสาร และคะแนน/รีวิวของคันนั้นจากผู้โดยสาร (การขับ · การจอดป้าย · สภาพรถ)
รีวิวได้แต้ม → แลกสติกเกอร์/รูปโปรไฟล์ · รีวิวที่ผิดกติกา report ได้ ผู้ดูแลซ่อนและหักแต้ม · ติดตั้งเป็นแอปบนมือถือได้ (PWA)

ใช้งานจริง: https://env-0241390.proen.app.ruk-com.cloud/
สไลด์นำเสนอ: `/pitch/final.html` · รายสปรินต์: `/pitch/sprint2.html` · `/pitch/sprint1.html` · รายงานสรุป: `/pitch/report.html` (`report.pdf`)

- `index.html` — หน้าเว็บ (ค้นหา · รีวิว · Feed · แลกของ · ฉัน) เรียก API ที่ `/api` ใน origin เดียวกัน
- `sw.js`, `manifest.webmanifest`, `icons/` — PWA (ไม่ cache `/api`)
- `styles/app.css` — Tailwind CSS v4 (ต้นฉบับ) → `npm run build:css` ได้ `app.css` ที่หน้าเว็บใช้
- `data.js` — ข้อมูลรุ่นรถ เขตการเดินรถ ค่าโดยสาร (คัดจาก
  [องค์การขนส่งมวลชนกรุงเทพ — วิกิพีเดีย](https://th.wikipedia.org/wiki/องค์การขนส่งมวลชนกรุงเทพ), CC BY-SA) — API ใช้ไฟล์เดียวกัน
- `api/` — REST API (Node.js 22 / Express / PostgreSQL) · `schema.sql` คือโครงสร้างตาราง · `test.js` คือ test
- `api/routes.json` — สายรถเมล์ + ป้ายในกรุงเทพ 380 สาย จาก [GTFS ของ สนข.](https://namtang-api.otp.go.th/download/namtang-gtfs.zip) (CC BY 4.0) · อัปเดตด้วย `python3 tools/import-gtfs.py` · `db-init.js` โหลดใหม่ทุกครั้งที่ deploy
- `api/rewards.json` — ของในร้าน · รูปโหลดด้วย `python3 tools/fetch-rewards.py`
- `deploy/` — Nginx, systemd (API + backup timer), สคริปต์ติดตั้งและ deploy ไป ruk-com
- `pitch/` — สไลด์ แต่ละ sprint, one-pager, รายงาน, ภาพหน้าจอ

## รันในเครื่อง

```bash
createdb bus_dev
cd api && npm install
DATABASE_URL=postgres:///bus_dev JWT_SECRET=$(openssl rand -hex 32) npm run db:init
DATABASE_URL=postgres:///bus_dev JWT_SECRET=... COOKIE_SECURE=0 npm start      # API ที่ 127.0.0.1:3000
```

หน้าเว็บ: `npm install && npm run watch:css` แล้ว `python3 -m http.server 8765` เปิด http://localhost:8765 (ไม่มี API = ค้นหาได้อย่างเดียว)

### Test

```bash
cd api && npm test
```

สร้างฐานข้อมูล `bus_test` ใหม่ทุกครั้ง เปิด API จริงที่พอร์ต 3999 แล้วยิง HTTP ทุกกรณี (แต้ม แลกของ report moderator refresh token ลบบัญชี)

### ตัวแปรใน `/etc/bus-api.env`

| ตัวแปร | ใช้ทำอะไร |
| --- | --- |
| `DATABASE_URL`, `JWT_SECRET` | ฐานข้อมูล · secret ของ JWT (≥ 32 ตัว) |
| `HOST`, `PORT` | address ที่ API ฟัง (เครื่องเดียว `127.0.0.1`) |
| `GOOGLE_CLIENT_ID` | ใส่แล้วเปิด Google Sign-In จริง (ตรวจ ID token) · ไม่ใส่ = โหมดจำลอง `@example.com` |
| `MOCK_LOGIN=0` | ปิดโหมดจำลองเมื่อใช้ Google จริงแล้ว |
| `MODERATOR_EMAILS` | อีเมลผู้ดูแล คั่นด้วย `,` (ได้ role ตอนเข้าสู่ระบบ) |
| `ALLOW_FROM`, `TRUST_PROXY` | ตอนแยก node: IP ของ web node ที่ยอมให้ต่อ API |
| `COOKIE_SECURE=0` | สำหรับรันในเครื่องผ่าน http เท่านั้น |

## Deploy

```bash
./deploy/deploy.sh
```

ติดตั้ง Node 22 (จาก nodejs.org ตรวจ SHA256) / PostgreSQL / Nginx ถ้ายังไม่มี, rsync ไฟล์, `npm ci`, migrate, restart `bus-api`,
เปิด `bus-backup.timer`, reload Nginx · secret อยู่ใน `/etc/bus-api.env` บน server เท่านั้น

แยก API + DB ไป node ที่ 2 (private network ของ ruk-com):

```bash
API_HOST=<node2>@gate.manage.ruk-com.cloud API_ADDR=<private IP node2> WEB_ADDR=<private IP node1> ./deploy/deploy.sh
```

API ฟัง private IP ของตัวเอง · iptables + `ALLOW_FROM` รับพอร์ต 3000 จาก web node เท่านั้น · Nginx proxy ไป `API_ADDR:3000`

### LINE: แชตบอท + แจ้งเตือน (ไม่บังคับ)

ไม่ตั้ง 3 ค่านี้ = ฟีเจอร์ปิด ปุ่มติดตามไม่ขึ้น

1. [LINE Official Account Manager](https://manager.line.biz/) → สร้าง Official Account → Settings → **Messaging API** → Enable
   (ตั้งแต่ปี 2024 สร้าง Messaging API channel จาก LINE Developers Console ตรง ๆ ไม่ได้แล้ว)
2. Messaging API: Webhook URL = `https://<โดเมน>/api/line/webhook` · Response settings: เปิด Webhooks · ปิด Greeting, Auto-response, Chat
3. LINE Developers → channel → แท็บ Messaging API → Issue **Channel access token (long-lived)**
4. `./deploy/set-line.sh` (ถาม secret · token · Bot ID แบบไม่แสดงบนจอ แล้ว restart API) → กด Verify ใน LINE Developers ต้องได้ Success
5. เมนูปุ่มใต้แชต: `ssh … 'set -a; . /etc/bus-api.env; set +a; node /opt/bus-api/line-richmenu.js https://<โดเมน>'` (รูปคือ `api/richmenu.png`)

แชตบอท (`api/linebot.js`) ตอบเฉพาะที่ค้นจากรหัสหรือพิกัดได้แน่นอน — ตอบด้วย reply ไม่กินโควตาแผนฟรี:
พิมพ์เลขข้างรถ `7-3077` → การ์ดรถ + ปุ่มรีวิว (ดาวทีละด้าน แล้วพิมพ์ข้อความ) / แจ้งเหตุ / ติดตาม ·
พิมพ์ `สาย 8` → ปลายทาง + คันที่คนบอกว่าวิ่งสายนี้ · ส่งตำแหน่ง → 3 ป้ายใกล้สุด (ไม่เกิน 1 กม.) + สายที่ผ่าน · `แต้ม` → ยอดแต้ม
รีวิว แจ้งเหตุ ติดตาม และแต้ม ต้องเชื่อมบัญชีก่อน: แท็บ "ฉัน" → เชื่อม LINE → ได้รหัส 6 ตัว (15 นาที) → ส่งให้บอท ·
บล็อกบอท = ยกเลิกการเชื่อมอัตโนมัติ · แจ้งเหตุส่ง push หาคนที่ติดตาม (กินโควตา) — ส่งเฉพาะแจ้งเหตุ

### Backup

`pg_dump` ทุกวัน 03:00 (เวลาไทย) ไปที่ `/var/backups/bus` เก็บ 7 วัน · ทดสอบกู้คืน: `bus-restore-test.sh` บน server ·
ดึงออกนอกเครื่อง: `./deploy/pull-backup.sh` (ลง `./backups/` ไม่อยู่ใน git)
