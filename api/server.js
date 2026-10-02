// คันนี้ดีไหม? — REST API (Sprint 1)
// Node.js / Express + PostgreSQL · ฟังเฉพาะ 127.0.0.1 ให้ Nginx เป็นด่านหน้า
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) { console.error("JWT_SECRET (>= 32 chars) is required"); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// ใช้ data.js ชุดเดียวกับหน้าเว็บ → จับคู่รุ่นรถจากเลขข้างรถ
const dataPath = [process.env.DATA_JS, path.join(__dirname, "data.js"), path.join(__dirname, "..", "data.js")].find(p => p && fs.existsSync(p));
const DATA = {};
vm.runInNewContext(fs.readFileSync(dataPath, "utf8") + "\nthis.MODELS = MODELS; this.ZONES = ZONES;", DATA);

// แต้ม (ค่าเริ่มต้น — ปรับได้หลังทดลองกับผู้ใช้)
const PTS = { signup: 20, review: 10, review_detail: 5, helpful_received: 2, helpful_daily_cap: 30, incident_confirmed: 20, incident_confirm_votes: 3 };
const AVATARS = ["🐸", "🦖", "🧢", "🐱", "🐼", "🦊", "🐧", "🐙", "🦉", "🐻"];
const BLOCKED_WORDS = ["ควย", "เหี้ย", "สัส", "แม่ง", "fuck", "shit"];

const app = express();
app.set("trust proxy", "loopback");
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- helpers ----------
function parseFleet(raw) {
  const m = String(raw || "").trim().match(/^([1-8])-(\d{4,5})$/);
  if (!m) return null;
  const zone = +m[1], num = m[2], v = parseInt(num, 10);
  const models = DATA.MODELS.filter(x => num.length === x.digits && num.startsWith(x.prefix) && (!x.range || (v >= x.range[0] && v <= x.range[1])));
  const model = models.find(x => x.zones[zone]) || models[0] || null;
  return { fleet_no: `${zone}-${num}`, zone, num, model_id: model ? model.id : null };
}
const signToken = u => jwt.sign({ sub: u.id, name: u.display_name }, JWT_SECRET, { expiresIn: "7d" });
function readAuth(req) {
  const h = req.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  try { return jwt.verify(h.slice(7), JWT_SECRET); } catch { return null; }
}
const optionalAuth = (req, _res, next) => { req.user = readAuth(req); next(); };
const requireAuth = (req, _res, next) => { req.user = readAuth(req); next(req.user ? undefined : new HttpError(401, "กรุณาเข้าสู่ระบบ")); };
const str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";
const star = v => Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
const hasBlocked = s => { const t = s.toLowerCase(); return BLOCKED_WORDS.some(w => t.includes(w)); };

async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
const addPoints = (c, userId, delta, reason, refId = null) =>
  c.query("INSERT INTO points_ledger (user_id, delta, reason, ref_id) VALUES ($1, $2, $3, $4)", [userId, delta, reason, refId]);

const REVIEW_COLS = `r.id, r.fleet_no, r.type, r.stars_driving, r.stars_stops, r.stars_condition, r.text, r.stop_name,
  to_char(r.ride_time, 'HH24:MI') AS ride_time, r.helpful_count, r.created_at, u.display_name, u.avatar, r.user_id`;
function shapeReview(r, me) {
  const { user_id, ...rest } = r;
  return { ...rest, mine: !!me && user_id === me.sub, voted: !!r.voted };
}

// ---------- routes ----------
app.get("/api/health", wrap(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, time: new Date().toISOString() });
}));

app.post("/api/auth/register", wrap(async (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const name = str(req.body.display_name, 30);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("อีเมลไม่ถูกต้อง");
  if (password.length < 8 || password.length > 72) throw bad("รหัสผ่านต้องยาว 8–72 ตัวอักษร");
  if (name.length < 2) throw bad("ชื่อที่แสดงต้องมีอย่างน้อย 2 ตัวอักษร");
  if (hasBlocked(name)) throw bad("ชื่อที่แสดงมีคำไม่เหมาะสม");
  const hash = await bcrypt.hash(password, 10);
  const avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  const user = await tx(async c => {
    const r = await c.query(
      "INSERT INTO users (email, password_hash, display_name, avatar) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING RETURNING id, display_name, avatar",
      [email, hash, name, avatar]);
    if (!r.rowCount) throw new HttpError(409, "อีเมลนี้สมัครแล้ว");
    await addPoints(c, r.rows[0].id, PTS.signup, "signup");
    return r.rows[0];
  });
  res.status(201).json({ token: signToken(user), user });
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const r = await pool.query("SELECT id, display_name, avatar, password_hash FROM users WHERE email = $1", [email]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
  res.json({ token: signToken(u), user: { id: u.id, display_name: u.display_name, avatar: u.avatar } });
}));

app.get("/api/me", requireAuth, wrap(async (req, res) => {
  const id = req.user.sub;
  const [u, pts, ledger, cnt] = await Promise.all([
    pool.query("SELECT id, email, display_name, avatar, role, created_at FROM users WHERE id = $1", [id]),
    pool.query("SELECT COALESCE(SUM(delta), 0)::int AS points FROM points_ledger WHERE user_id = $1", [id]),
    pool.query("SELECT delta, reason, ref_id, created_at FROM points_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20", [id]),
    pool.query("SELECT count(*)::int AS reviews, COALESCE(SUM(helpful_count), 0)::int AS helpful FROM reviews WHERE user_id = $1 AND status = 'visible'", [id]),
  ]);
  if (!u.rowCount) throw new HttpError(401, "กรุณาเข้าสู่ระบบใหม่");
  res.json({ user: u.rows[0], points: pts.rows[0].points, ledger: ledger.rows, ...cnt.rows[0] });
}));

app.get("/api/buses/:fleetNo", wrap(async (req, res) => {
  const f = parseFleet(req.params.fleetNo);
  if (!f) throw bad("เลขข้างรถต้องอยู่ในรูปแบบ เขต-หมายเลข เช่น 7-3077");
  const r = await pool.query(`
    SELECT count(*) FILTER (WHERE type = 'review')::int AS reviews,
           count(*) FILTER (WHERE type = 'incident')::int AS incidents,
           round(avg(stars_driving), 1)::float AS driving,
           round(avg(stars_stops), 1)::float AS stops,
           round(avg(stars_condition), 1)::float AS condition,
           round(avg((stars_driving + stars_stops + stars_condition) / 3.0), 1)::float AS avg
    FROM reviews WHERE fleet_no = $1 AND status = 'visible'`, [f.fleet_no]);
  res.json({ fleet_no: f.fleet_no, zone: f.zone, model_id: f.model_id, stats: r.rows[0] });
}));

app.get("/api/buses/:fleetNo/reviews", optionalAuth, wrap(async (req, res) => {
  const f = parseFleet(req.params.fleetNo);
  if (!f) throw bad("เลขข้างรถไม่ถูกต้อง");
  const order = req.query.sort === "helpful" ? "r.helpful_count DESC, r.created_at DESC" : "r.created_at DESC";
  const typeFilter = req.query.type === "incident" ? "AND r.type = 'incident'" : "";
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const me = req.user ? req.user.sub : null;
  const r = await pool.query(`
    SELECT ${REVIEW_COLS}, EXISTS (SELECT 1 FROM review_votes v WHERE v.review_id = r.id AND v.user_id = $2) AS voted
    FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.fleet_no = $1 AND r.status = 'visible' ${typeFilter}
    ORDER BY ${order} LIMIT $3 OFFSET $4`, [f.fleet_no, me, limit, offset]);
  res.json({ fleet_no: f.fleet_no, items: r.rows.map(x => shapeReview(x, req.user)) });
}));

app.post("/api/reviews", requireAuth, wrap(async (req, res) => {
  const b = req.body || {};
  const f = parseFleet(b.fleet_no);
  if (!f) throw bad("เลขข้างรถต้องระบุเขต เช่น 7-3077");
  const type = b.type === "incident" ? "incident" : "review";
  const text = str(b.text, 500);
  if (!text) throw bad(type === "incident" ? "เล่าเหตุการณ์สั้น ๆ ก่อนส่ง" : "เขียนรีวิวสั้น ๆ ก่อนส่ง");
  if (hasBlocked(text)) throw bad("ข้อความมีคำไม่เหมาะสม — รีวิวรถ ไม่ใช่ตัวบุคคลนะ");
  const s = [star(b.stars_driving), star(b.stars_stops), star(b.stars_condition)];
  if (type === "review" && s.some(x => x === null)) throw bad("ให้ดาวให้ครบ 3 ด้าน");
  const stop = str(b.stop_name, 80) || null;
  const time = typeof b.ride_time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.ride_time) ? b.ride_time : null;
  const uid = req.user.sub;

  const out = await tx(async c => {
    await c.query("INSERT INTO buses (fleet_no, zone, model_id) VALUES ($1, $2, $3) ON CONFLICT (fleet_no) DO NOTHING", [f.fleet_no, f.zone, f.model_id]);
    let r;
    try {
      r = await c.query(`INSERT INTO reviews (user_id, fleet_no, type, stars_driving, stars_stops, stars_condition, text, stop_name, ride_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [uid, f.fleet_no, type, ...(type === "review" ? s : [null, null, null]), text, stop, time]);
    } catch (e) {
      if (e.code === "23505") throw new HttpError(409, "วันนี้รีวิวคันนี้ไปแล้ว — พรุ่งนี้มาใหม่นะ");
      throw e;
    }
    const id = r.rows[0].id;
    let earned = 0;
    if (type === "review") {
      await addPoints(c, uid, PTS.review, "review", id); earned += PTS.review;
      if (stop && time) { await addPoints(c, uid, PTS.review_detail, "review_detail", id); earned += PTS.review_detail; }
    }
    return { id, earned };
  });
  res.status(201).json(out);
}));

app.post("/api/reviews/:id/helpful", requireAuth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) throw bad("รีวิวไม่ถูกต้อง");
  const uid = req.user.sub;
  const out = await tx(async c => {
    const r = await c.query("SELECT id, user_id, type, helpful_count FROM reviews WHERE id = $1 AND status = 'visible' FOR UPDATE", [id]);
    const rv = r.rows[0];
    if (!rv) throw new HttpError(404, "ไม่พบรีวิวนี้");
    if (rv.user_id === uid) throw bad("กดให้รีวิวตัวเองไม่ได้");
    const v = await c.query("INSERT INTO review_votes (review_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, uid]);
    if (!v.rowCount) throw new HttpError(409, "กดไปแล้ว");
    const count = rv.helpful_count + 1;
    await c.query("UPDATE reviews SET helpful_count = $2 WHERE id = $1", [id, count]);
    // ผู้เขียนได้ +2 ต่อโหวต แต่ไม่เกินเพดานต่อวัน
    const today = await c.query(`SELECT COALESCE(SUM(delta), 0)::int AS s FROM points_ledger
      WHERE user_id = $1 AND reason = 'helpful_received' AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok'`, [rv.user_id]);
    if (today.rows[0].s + PTS.helpful_received <= PTS.helpful_daily_cap) await addPoints(c, rv.user_id, PTS.helpful_received, "helpful_received", id);
    // แจ้งเหตุที่มีคนยืนยันครบ → โบนัสครั้งเดียว
    if (rv.type === "incident" && count === PTS.incident_confirm_votes) await addPoints(c, rv.user_id, PTS.incident_confirmed, "incident_confirmed", id);
    return { id, helpful_count: count, voted: true };
  });
  res.json(out);
}));

app.get("/api/feed", optionalAuth, wrap(async (req, res) => {
  const sort = req.query.sort === "top" ? "r.helpful_count DESC, r.created_at DESC" : "r.created_at DESC";
  const typeFilter = req.query.type === "incident" ? "AND r.type = 'incident'" : "";
  const zone = /^[1-8]$/.test(req.query.zone || "") ? +req.query.zone : null;
  const me = req.user ? req.user.sub : null;
  const r = await pool.query(`
    SELECT ${REVIEW_COLS}, EXISTS (SELECT 1 FROM review_votes v WHERE v.review_id = r.id AND v.user_id = $1) AS voted
    FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'visible' ${typeFilter} AND ($2::int IS NULL OR split_part(r.fleet_no, '-', 1)::int = $2)
    ORDER BY ${sort} LIMIT 30`, [me, zone]);
  res.json({ items: r.rows.map(x => shapeReview(x, req.user)) });
}));

app.use("/api", (_req, _res, next) => next(new HttpError(404, "ไม่พบ endpoint")));
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") err = bad("JSON ไม่ถูกต้อง");
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "ระบบขัดข้อง ลองใหม่อีกครั้ง" : err.message });
});

app.listen(PORT, HOST, () => console.log(`bus-api listening on ${HOST}:${PORT} · ${DATA.MODELS.length} models`));
