# คันนี้ดีไหม? — ค้นหาและรีวิวรถเมล์ ขสมก. รายคัน

กรอกหมายเลขข้างรถ เช่น `7-3077` หรือ `2-70235` แล้วดูยี่ห้อ/รุ่น สีรถ ปีที่เริ่มให้บริการ เขตการเดินรถ อู่
อัตราค่าโดยสาร และคะแนน/รีวิวของคันนั้นจากผู้โดยสาร (การขับ · การจอดป้าย · สภาพรถ) พร้อมระบบแต้ม

ใช้งานจริง: https://env-0241390.proen.app.ruk-com.cloud/ · สไลด์ Sprint 1: `/pitch/sprint1.html`

- `index.html` — หน้าเว็บ (ค้นหา · รีวิว · Feed · แลกของ · ฉัน) เรียก API ที่ `/api` ใน origin เดียวกัน
- `data.js` — ข้อมูลรุ่นรถ เขตการเดินรถ ค่าโดยสาร (คัดจาก
  [องค์การขนส่งมวลชนกรุงเทพ — วิกิพีเดีย](https://th.wikipedia.org/wiki/องค์การขนส่งมวลชนกรุงเทพ), CC BY-SA) — API ใช้ไฟล์เดียวกัน
- `api/` — REST API (Node.js / Express / PostgreSQL) · `schema.sql` คือโครงสร้างตาราง
- `deploy/` — Nginx, systemd unit, สคริปต์ติดตั้งและ deploy ไป ruk-com

## รันในเครื่อง

```bash
createdb bus_dev
cd api && npm install
DATABASE_URL=postgres:///bus_dev JWT_SECRET=$(openssl rand -hex 32) npm run db:init
DATABASE_URL=postgres:///bus_dev JWT_SECRET=... npm start      # API ที่ 127.0.0.1:3000
```

หน้าเว็บอย่างเดียว (ไม่มีรีวิว): `python3 -m http.server 8765` แล้วเปิด http://localhost:8765

## Deploy

```bash
./deploy/deploy.sh
```

ติดตั้ง Node/PostgreSQL ถ้ายังไม่มี, rsync ไฟล์, `npm ci`, สร้างตาราง, restart `bus-api`, reload Nginx
(สำรอง nginx default เดิมไว้ที่ `/root/nginx-default.before-bus`) · secret อยู่ใน `/etc/bus-api.env` บน server เท่านั้น
