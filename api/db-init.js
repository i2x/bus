// สร้างตารางจาก schema.sql + upsert ของในร้านจาก rewards.json (รันซ้ำได้)
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, "rewards.json"), "utf8"));
  for (const x of items) {
    await pool.query(`INSERT INTO rewards (id, type, name, emoji, cost, sort, img, credit) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET type = $2, name = $3, emoji = $4, cost = $5, sort = $6, img = $7, credit = $8`,
      [x.id, x.type, x.name, x.emoji, x.cost, x.sort, x.img || null, x.credit || null]);
  }
  // คนที่ใช้รูปโปรไฟล์จากร้านอยู่ → อัปเดต path รูปตามรายการล่าสุด
  await pool.query(`UPDATE users u SET avatar_img = w.img FROM rewards w WHERE w.type = 'avatar' AND w.emoji = u.avatar AND w.img IS NOT NULL AND u.avatar_img IS NULL AND w.cost > 0
    AND EXISTS (SELECT 1 FROM user_rewards ur WHERE ur.user_id = u.id AND ur.reward_id = w.id)`);
  console.log(`schema ok · ${items.length} rewards`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
