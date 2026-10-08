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
  // ของที่เคยต้องแลกแต่ตอนนี้ฟรีแล้ว → คืนแต้มให้คนที่แลกไป (ครั้งเดียวต่อรายการ)
  const refund = await pool.query(`INSERT INTO points_ledger (user_id, delta, reason, note)
    SELECT l.user_id, -l.delta, 'refund', l.note FROM points_ledger l
    WHERE l.reason = 'redeem' AND l.note IN (SELECT name FROM rewards WHERE cost = 0)
      AND NOT EXISTS (SELECT 1 FROM points_ledger r WHERE r.user_id = l.user_id AND r.reason = 'refund' AND r.note = l.note)`);
  if (refund.rowCount) console.log(`refunded ${refund.rowCount} redeem(s) of items that are now free`);
  // คนที่ใช้รูปโปรไฟล์จากร้านอยู่ → อัปเดต path รูปตามรายการล่าสุด
  await pool.query(`UPDATE users u SET avatar_img = w.img FROM rewards w WHERE w.type = 'avatar' AND w.emoji = u.avatar AND w.img IS NOT NULL AND u.avatar_img IS NULL AND w.cost > 0
    AND EXISTS (SELECT 1 FROM user_rewards ur WHERE ur.user_id = u.id AND ur.reward_id = w.id)`);
  // สายรถเมล์ + ป้าย: ลบแล้วโหลดใหม่ทั้งชุดใน transaction เดียว
  const g = JSON.parse(fs.readFileSync(path.join(__dirname, "routes.json"), "utf8"));
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("DELETE FROM gtfs_route_stops; DELETE FROM gtfs_routes; DELETE FROM gtfs_stops");
    await c.query(`INSERT INTO gtfs_stops (id, name, lat, lon)
      SELECT key, value->>0, (value->>1)::float8, (value->>2)::float8 FROM jsonb_each($1::jsonb)`, [JSON.stringify(g.stops)]);
    await c.query(`INSERT INTO gtfs_routes (id, no, old_no, name, agency, kind, dirs)
      SELECT id, no, old, name, agency, kind, dirs FROM jsonb_to_recordset($1::jsonb)
        AS x(id text, no text, old text, name text, agency text, kind text, dirs jsonb)`, [JSON.stringify(g.routes)]);
    await c.query(`INSERT INTO gtfs_route_stops (route_id, stop_id)
      SELECT DISTINCT g.id, st FROM gtfs_routes g, jsonb_array_elements(g.dirs) d, jsonb_array_elements_text(d->'stops') st`);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  console.log(`schema ok · ${items.length} rewards · ${g.routes.length} routes (GTFS ${g.version})`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
