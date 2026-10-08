// คันนี้ดีไหม? — REST API (Sprint 2)
// Node.js / Express + PostgreSQL · ฟังเฉพาะ private address ให้ Nginx เป็นด่านหน้า
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { hasBlocked, hasPhone } = require("./wordfilter");

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) { console.error("JWT_SECRET (>= 32 chars) is required"); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
// Google Sign-In จริงเปิดเมื่อมี client ID · โหมดจำลอง (@example.com) ปิดได้ด้วย MOCK_LOGIN=0
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const MOCK_LOGIN = process.env.MOCK_LOGIN !== "0";
const MODERATOR_EMAILS = (process.env.MODERATOR_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "0";
const ACCESS_TTL = "15m", REFRESH_DAYS = 30;
// แจ้งเตือนทาง LINE Messaging API — เปิดเมื่อตั้งครบ 3 ค่า (ไม่ครบ = ปิดฟีเจอร์ ปุ่มติดตามไม่ขึ้น)
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_BOT_ID = process.env.LINE_BOT_ID || "";             // @xxxx ของ Official Account
const LINE_API = process.env.LINE_API_BASE || "https://api.line.me";
const LINE_ON = !!(LINE_SECRET && LINE_TOKEN && LINE_BOT_ID);
const MAX_FOLLOWS = 30;
const REFRESH_REUSE_GRACE_MS = process.env.REFRESH_GRACE_MS != null ? +process.env.REFRESH_GRACE_MS : 20000;

// ใช้ data.js ชุดเดียวกับหน้าเว็บ → จับคู่รุ่นรถจากเลขข้างรถ
const dataPath = [process.env.DATA_JS, path.join(__dirname, "data.js"), path.join(__dirname, "..", "data.js")].find(p => p && fs.existsSync(p));
const DATA = {};
vm.runInNewContext(fs.readFileSync(dataPath, "utf8") + "\nthis.MODELS = MODELS; this.ZONES = ZONES;", DATA);

// แต้ม (ค่าเริ่มต้น — ปรับได้หลังทดลองกับผู้ใช้)
const PTS = { signup: 20, review: 10, review_detail: 5, helpful_received: 2, helpful_daily_cap: 30, incident_confirmed: 20, incident_confirm_votes: 3, report_upheld: -20 };
const REPORT_AUTO_HIDE = 3;   // report ที่ยังไม่ตัดสินครบเท่านี้ → ซ่อนไว้ก่อนรอ moderator
const REPORT_REASONS = ["spam", "rude", "personal", "fake"];
const AVATARS = ["🐸", "🦖", "🧢", "🐱", "🐼", "🦊", "🐧", "🐙", "🦉", "🐻"];

const app = express();
app.set("trust proxy", process.env.TRUST_PROXY || "loopback");
app.disable("x-powered-by");
// แยก node: รับเฉพาะ request จาก web node (ซ้อนกับ firewall อีกชั้น)
const ALLOW_FROM = (process.env.ALLOW_FROM || "").split(",").map(x => x.trim()).filter(Boolean);
if (ALLOW_FROM.length) app.use((req, res, next) => {
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ALLOW_FROM.includes(ip)) return next();
  res.status(403).end();
});
// webhook ของ LINE ต้องใช้ body ดิบตรวจลายเซ็น → ลงทะเบียนก่อน express.json
app.post("/api/line/webhook", express.raw({ type: "*/*", limit: "256kb" }), (req, res, next) => lineWebhook(req, res).catch(next));
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
const signToken = u => jwt.sign({ sub: u.id, name: u.display_name }, JWT_SECRET, { expiresIn: ACCESS_TTL });
function readAuth(req) {
  const h = req.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  try { return jwt.verify(h.slice(7), JWT_SECRET); } catch { return null; }
}
const optionalAuth = (req, _res, next) => { req.user = readAuth(req); next(); };
const requireAuth = (req, _res, next) => { req.user = readAuth(req); next(req.user ? undefined : new HttpError(401, "กรุณาเข้าสู่ระบบ")); };
const str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";
const star = v => Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
const forbidden = (status, msg) => new HttpError(status, msg);
// ของราคา 0 = ฟรี ทุกคนใช้ได้ · ของที่มีราคาต้องแลกก่อน
const OWNS = (w, uid) => `(${w}.cost = 0 OR EXISTS (SELECT 1 FROM user_rewards ur WHERE ur.reward_id = ${w}.id AND ur.user_id = ${uid}))`;

// role อ่านจาก DB ทุกครั้ง (ถอดสิทธิ์แล้วมีผลทันที ไม่ต้องรอ token หมดอายุ)
const requireMod = wrap(async (req, _res, next) => {
  req.user = readAuth(req);
  if (!req.user) throw new HttpError(401, "กรุณาเข้าสู่ระบบ");
  const r = await pool.query("SELECT role FROM users WHERE id = $1", [req.user.sub]);
  if (r.rows[0]?.role !== "moderator") throw forbidden(403, "เฉพาะผู้ดูแล");
  next();
});

// ---------- refresh token (cookie HttpOnly · เก็บใน DB เป็น sha256) ----------
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const COOKIE = "bus_rt";
const cookieOpts = { httpOnly: true, secure: COOKIE_SECURE, sameSite: "strict", path: "/api/auth" };
function readCookie(req, name) {
  for (const part of (req.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
async function issueRefresh(c, res, userId, family = crypto.randomUUID()) {
  const raw = crypto.randomBytes(32).toString("base64url");
  await c.query(`INSERT INTO refresh_tokens (user_id, family, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, family, sha256(raw), REFRESH_DAYS]);
  res.cookie(COOKIE, raw, { ...cookieOpts, maxAge: REFRESH_DAYS * 86400e3 });
}

async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
const addPoints = (c, userId, delta, reason, refId = null) =>
  c.query("INSERT INTO points_ledger (user_id, delta, reason, ref_id) VALUES ($1, $2, $3, $4)", [userId, delta, reason, refId]);

// คอลัมน์รีวิว + สิ่งที่ "ฉัน" ทำกับรีวิวนั้น ($me = เลข parameter ของ user id, null = ไม่ได้เข้าสู่ระบบ)
const reviewCols = me => `r.id, r.fleet_no, r.type, r.stars_driving, r.stars_stops, r.stars_condition, r.text, r.stop_name, r.route_id, r.route_label,
  to_char(r.ride_time, 'HH24:MI') AS ride_time, r.helpful_count, r.created_at, u.display_name, u.avatar, u.avatar_img, r.user_id,
  EXISTS (SELECT 1 FROM review_votes v WHERE v.review_id = r.id AND v.user_id = ${me}) AS voted,
  EXISTS (SELECT 1 FROM reports p WHERE p.review_id = r.id AND p.reporter_id = ${me}) AS reported,
  (SELECT sticker_id FROM review_reactions x WHERE x.review_id = r.id AND x.user_id = ${me}) AS my_reaction,
  (SELECT COALESCE(json_agg(json_build_object('id', a.sticker_id, 'name', a.name, 'emoji', a.emoji, 'img', a.img, 'n', a.n) ORDER BY a.n DESC, a.sticker_id), '[]')
     FROM (SELECT x.sticker_id, w.name, w.emoji, w.img, count(*)::int AS n FROM review_reactions x JOIN rewards w ON w.id = x.sticker_id
           WHERE x.review_id = r.id GROUP BY 1, 2, 3, 4) a) AS reactions`;
function shapeReview(r, me) {
  const { user_id, ...rest } = r;
  return { ...rest, mine: !!me && user_id === me.sub, voted: !!r.voted, reported: !!r.reported };
}

// ---------- routes ----------
app.get("/api/health", wrap(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true, time: new Date().toISOString() });
}));

app.get("/api/config", (_req, res) => res.json({ google_client_id: GOOGLE_CLIENT_ID || null, mock_login: MOCK_LOGIN, line: LINE_ON ? { bot_id: LINE_BOT_ID } : null }));

// ตรวจ ID token กับ Google (aud ต้องเป็น client ของเรา · อีเมลยืนยันแล้ว · ยังไม่หมดอายุ)
async function verifyGoogle(credential) {
  if (typeof credential !== "string" || credential.length > 4096) throw bad("ข้อมูลเข้าสู่ระบบไม่ถูกต้อง");
  let t;
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential), { signal: AbortSignal.timeout(5000) });
    t = r.ok ? await r.json() : null;
  } catch { throw new HttpError(502, "ติดต่อ Google ไม่ได้ ลองใหม่อีกครั้ง"); }
  if (!t || t.aud !== GOOGLE_CLIENT_ID || !["accounts.google.com", "https://accounts.google.com"].includes(t.iss)
      || String(t.email_verified) !== "true" || +t.exp * 1000 < Date.now() || !t.sub || !t.email) throw new HttpError(401, "ยืนยันบัญชี Google ไม่ผ่าน");
  // ชื่อที่แสดงในรีวิวเป็นสาธารณะ → ใช้แค่ชื่อต้น ไม่ใช้ชื่อเต็ม
  return { sub: t.sub, email: String(t.email).toLowerCase(), name: str(t.given_name || String(t.name || "").split(" ")[0], 30) };
}

// เข้าสู่ระบบด้วย Google — ครั้งแรก = สร้างบัญชี + 20 แต้ม · ไม่มีรหัสผ่านในระบบ
// โหมดจำลอง: ยังไม่มี client ID → รับเฉพาะอีเมล @example.com (บัญชีทดสอบ) กันสวมรอยบัญชีจริง
app.post("/api/auth/google", wrap(async (req, res) => {
  let acc;
  if (GOOGLE_CLIENT_ID && req.body.credential) acc = await verifyGoogle(req.body.credential);
  else {
    if (!MOCK_LOGIN) throw bad("กรุณาเข้าสู่ระบบด้วยบัญชี Google");
    const email = str(req.body.email, 120).toLowerCase();
    if (!/^[a-z0-9._-]+@example\.com$/.test(email)) throw bad("โหมดจำลองรับเฉพาะบัญชีทดสอบ @example.com");
    acc = { sub: "mock:" + email, email, name: str(req.body.name, 30) };
  }
  let name = acc.name;
  if (name.length < 2 || hasBlocked(name)) {
    if (!GOOGLE_CLIENT_ID || !req.body.credential) throw bad("ชื่อบัญชีไม่ถูกต้อง");
    name = "ผู้โดยสาร";
  }
  const role = MODERATOR_EMAILS.includes(acc.email) ? "moderator" : null;
  const out = await tx(async c => {
    let r = await c.query("SELECT id, display_name, avatar FROM users WHERE google_sub = $1", [acc.sub]);
    if (!r.rowCount) {
      r = await c.query("UPDATE users SET google_sub = $1 WHERE email = $2 AND google_sub IS NULL RETURNING id, display_name, avatar", [acc.sub, acc.email]);
    }
    let created = false;
    if (!r.rowCount) {
      // รูปโปรไฟล์เริ่มต้น: สุ่มจากรูปฟรี (เปลี่ยนเองได้ทันที)
      const free = (await c.query("SELECT emoji, img FROM rewards WHERE type = 'avatar' AND cost = 0 ORDER BY random() LIMIT 1")).rows[0]
        || { emoji: AVATARS[Math.floor(Math.random() * AVATARS.length)], img: null };
      r = await c.query("INSERT INTO users (email, display_name, avatar, avatar_img, google_sub) VALUES ($1, $2, $3, $4, $5) RETURNING id, display_name, avatar",
        [acc.email, name, free.emoji, free.img, acc.sub]);
      await addPoints(c, r.rows[0].id, PTS.signup, "signup");
      created = true;
    }
    if (role) await c.query("UPDATE users SET role = $2 WHERE id = $1", [r.rows[0].id, role]);
    await issueRefresh(c, res, r.rows[0].id);
    return { user: r.rows[0], created };
  });
  res.status(out.created ? 201 : 200).json({ token: signToken(out.user), ...out });
}));

// ขอ access token ใหม่ด้วย refresh token ใน cookie · หมุน token ทุกครั้ง
// token ที่ถูกเพิกถอนแล้วถูกใช้ซ้ำ = อาจถูกขโมย → เพิกถอนทั้ง family (เว้นช่วงสั้น ๆ ให้แท็บที่ขอพร้อมกัน)
app.post("/api/auth/refresh", wrap(async (req, res) => {
  const raw = readCookie(req, COOKIE);
  const fail = () => { res.clearCookie(COOKIE, cookieOpts); return new HttpError(401, "กรุณาเข้าสู่ระบบใหม่"); };
  if (!raw) throw fail();
  const out = await tx(async c => {
    const r = await c.query(`SELECT t.id, t.user_id, t.family, t.revoked_at, t.expires_at < now() AS expired, u.display_name
      FROM refresh_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 FOR UPDATE OF t`, [sha256(raw)]);
    const t = r.rows[0];
    if (!t || t.expired) return null;
    if (t.revoked_at) {
      // ช่วงผ่อนผันใช้ได้เฉพาะ family ที่ยังมี token ใช้งานอยู่ (logout แล้ว = ทั้ง family ถูกเพิกถอน → ไม่ผ่อนผัน)
      const live = await c.query("SELECT 1 FROM refresh_tokens WHERE family = $1 AND revoked_at IS NULL AND expires_at > now()", [t.family]);
      if (!live.rowCount || Date.now() - t.revoked_at.getTime() > REFRESH_REUSE_GRACE_MS) {
        await c.query("UPDATE refresh_tokens SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL", [t.family]);
        return null;
      }
    }
    if (!t.revoked_at) await c.query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1", [t.id]);
    await issueRefresh(c, res, t.user_id, t.family);
    return { id: t.user_id, display_name: t.display_name };
  });
  if (!out) throw fail();
  res.json({ token: signToken(out) });
}));

app.post("/api/auth/logout", wrap(async (req, res) => {
  const raw = readCookie(req, COOKIE);
  if (raw) await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL
    AND family = (SELECT family FROM refresh_tokens WHERE token_hash = $1)`, [sha256(raw)]);
  res.clearCookie(COOKIE, cookieOpts);
  res.json({ ok: true });
}));

app.get("/api/me", requireAuth, wrap(async (req, res) => {
  const id = req.user.sub;
  const [u, pts, ledger, cnt, owned, follows] = await Promise.all([
    pool.query("SELECT id, email, display_name, avatar, avatar_img, role, created_at, line_user_id IS NOT NULL AS line_linked FROM users WHERE id = $1", [id]),
    pool.query("SELECT COALESCE(SUM(delta), 0)::int AS points FROM points_ledger WHERE user_id = $1", [id]),
    pool.query("SELECT delta, reason, ref_id, note, created_at FROM points_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20", [id]),
    pool.query("SELECT count(*)::int AS reviews, COALESCE(SUM(helpful_count), 0)::int AS helpful FROM reviews WHERE user_id = $1 AND status = 'visible'", [id]),
    pool.query("SELECT reward_id FROM user_rewards WHERE user_id = $1 ORDER BY created_at", [id]),
    pool.query(`SELECT f.kind, f.target, COALESCE(NULLIF(g.old_no, ''), g.no, f.target) AS label, g.name FROM follows f
      LEFT JOIN gtfs_routes g ON f.kind = 'route' AND g.id = f.target WHERE f.user_id = $1 ORDER BY f.created_at DESC`, [id]),
  ]);
  if (!u.rowCount) throw new HttpError(401, "กรุณาเข้าสู่ระบบใหม่");
  res.json({ user: u.rows[0], points: pts.rows[0].points, ledger: ledger.rows, owned: owned.rows.map(x => x.reward_id), follows: follows.rows, ...cnt.rows[0] });
}));

// ลบบัญชี (PDPA) — รีวิว โหวต แต้ม ของที่แลก ลบตามทั้งหมด
app.delete("/api/me", requireAuth, wrap(async (req, res) => {
  await tx(async c => {
    await c.query(`UPDATE reviews SET helpful_count = helpful_count - 1
      WHERE id IN (SELECT review_id FROM review_votes WHERE user_id = $1) AND user_id <> $1`, [req.user.sub]);
    await c.query("DELETE FROM users WHERE id = $1", [req.user.sub]);
  });
  res.clearCookie(COOKIE, cookieOpts);
  res.json({ ok: true });
}));

// ---------- LINE: เชื่อมบัญชี + ติดตามรถ/สาย ----------
const requireLine = (_req, _res, next) => next(LINE_ON ? undefined : new HttpError(404, "ยังไม่เปิดแจ้งเตือนทาง LINE"));
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // ไม่มี 0/O 1/I/L ที่อ่านสับสน
app.post("/api/me/line", requireLine, requireAuth, wrap(async (req, res) => {
  const code = Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join("");
  await tx(async c => {
    await c.query("DELETE FROM line_link_codes WHERE user_id = $1 OR expires_at < now()", [req.user.sub]);
    await c.query("INSERT INTO line_link_codes (code, user_id, expires_at) VALUES ($1, $2, now() + interval '15 minutes')", [code, req.user.sub]);
  });
  res.status(201).json({ code, bot_id: LINE_BOT_ID,
    url: `https://line.me/R/oaMessage/${encodeURIComponent(LINE_BOT_ID)}/?${encodeURIComponent("เชื่อมบัญชี " + code)}`,
    add_friend: `https://line.me/R/ti/p/${encodeURIComponent(LINE_BOT_ID)}` });
}));
app.delete("/api/me/line", requireAuth, wrap(async (req, res) => {
  await pool.query("UPDATE users SET line_user_id = NULL WHERE id = $1", [req.user.sub]);
  res.json({ ok: true });
}));
async function followTarget(kind, raw) {
  if (kind === "bus") { const f = parseFleet(raw); if (!f) throw bad("เลขข้างรถไม่ถูกต้อง"); return f.fleet_no; }
  if (kind === "route") {
    const r = await pool.query("SELECT id FROM gtfs_routes WHERE id = $1", [String(raw).slice(0, 20)]);
    if (!r.rowCount) throw new HttpError(404, "ไม่พบสายนี้"); return r.rows[0].id;
  }
  throw bad("ติดตามได้เฉพาะรถหรือสาย");
}
app.post("/api/follows/:kind/:target", requireAuth, wrap(async (req, res) => {
  const target = await followTarget(req.params.kind, req.params.target);
  const n = await pool.query("SELECT count(*)::int AS n FROM follows WHERE user_id = $1", [req.user.sub]);
  if (n.rows[0].n >= MAX_FOLLOWS) throw bad(`ติดตามได้สูงสุด ${MAX_FOLLOWS} รายการ — เลิกติดตามอันเก่าที่แท็บ "ฉัน" ก่อน`);
  await pool.query("INSERT INTO follows (user_id, kind, target) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [req.user.sub, req.params.kind, target]);
  res.status(201).json({ following: true });
}));
app.delete("/api/follows/:kind/:target", requireAuth, wrap(async (req, res) => {
  await pool.query("DELETE FROM follows WHERE user_id = $1 AND kind = $2 AND target = $3", [req.user.sub, req.params.kind, req.params.target]);
  res.json({ following: false });
}));

async function linePost(p, body) {
  const r = await fetch(LINE_API + p, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + LINE_TOKEN },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`LINE ${p} → ${r.status} ${(await r.text()).slice(0, 200)}`);
}
const lineReply = (replyToken, text) => replyToken ? linePost("/v2/bot/message/reply", { replyToken, messages: [{ type: "text", text }] }) : null;

// LINE ส่ง event มาที่นี่ (ตั้ง URL ใน LINE Developers: https://<โดเมน>/api/line/webhook)
async function lineWebhook(req, res) {
  if (!LINE_ON) throw new HttpError(404, "ไม่พบ endpoint");
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const sig = Buffer.from(String(req.get("x-line-signature") || ""), "base64");
  const want = crypto.createHmac("sha256", LINE_SECRET).update(raw).digest();
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) throw new HttpError(401, "ลายเซ็นไม่ถูกต้อง");
  let events = [];
  try { events = JSON.parse(raw.toString("utf8")).events || []; } catch { throw bad("JSON ไม่ถูกต้อง"); }
  for (const ev of events) await lineEvent(ev).catch(e => console.error("line event:", e.message));
  res.json({ ok: true });
}
async function lineEvent(ev) {
  const uid = ev.source && ev.source.type === "user" ? ev.source.userId : null;
  if (!uid) return;
  if (ev.type === "unfollow") return pool.query("UPDATE users SET line_user_id = NULL WHERE line_user_id = $1", [uid]);
  if (ev.type === "follow") return lineReply(ev.replyToken, "สวัสดีจาก คันนี้ดีไหม? 🚌\nเชื่อมบัญชี: ในเว็บไปที่แท็บ \"ฉัน\" กด \"เชื่อม LINE\" แล้วส่งรหัส 6 ตัวมาที่นี่\nจากนั้นกด \"ติดตาม\" รถหรือสายที่นั่งประจำ — มีคนแจ้งเหตุเมื่อไหร่จะบอกทันที");
  if (ev.type !== "message" || !ev.message || ev.message.type !== "text") return;
  const m = String(ev.message.text).toUpperCase().match(new RegExp(`(?:^|[^A-Z0-9])([${CODE_CHARS}]{6})(?![A-Z0-9])`));
  if (!m) return lineReply(ev.replyToken, "ส่งรหัส 6 ตัวจากแท็บ \"ฉัน\" ในเว็บเพื่อเชื่อมบัญชี · บอทนี้ใช้ส่งแจ้งเตือนอย่างเดียว ตอบแชตไม่ได้");
  const name = await tx(async c => {
    const code = await c.query("DELETE FROM line_link_codes WHERE code = $1 AND expires_at > now() RETURNING user_id", [m[1]]);
    if (!code.rowCount) return null;
    await c.query("UPDATE users SET line_user_id = NULL WHERE line_user_id = $1", [uid]);   // LINE 1 บัญชี ↔ เว็บ 1 บัญชี
    const u = await c.query("UPDATE users SET line_user_id = $1 WHERE id = $2 RETURNING display_name", [uid, code.rows[0].user_id]);
    return u.rows[0].display_name;
  });
  return lineReply(ev.replyToken, name
    ? `เชื่อมกับบัญชี "${name}" แล้ว ✅\nกด "ติดตาม" ที่หน้ารถหรือหน้าสายในเว็บ — มีคนแจ้งเหตุเมื่อไหร่จะส่งมาที่นี่`
    : "รหัสไม่ถูกต้องหรือหมดอายุแล้ว (ใช้ได้ 15 นาที) — ขอรหัสใหม่ที่แท็บ \"ฉัน\"");
}
// มีคนแจ้งเหตุ → ส่ง LINE ให้คนที่ติดตามรถคันนั้นหรือสายนั้น (ยกเว้นคนแจ้งเอง)
async function notifyIncident(x) {
  if (!LINE_ON) return;
  const r = await pool.query(`SELECT DISTINCT u.line_user_id FROM follows f JOIN users u ON u.id = f.user_id
    WHERE u.line_user_id IS NOT NULL AND u.id <> $1 AND ((f.kind = 'bus' AND f.target = $2) OR (f.kind = 'route' AND f.target = $3))`,
    [x.author, x.fleet_no, x.route ? x.route.id : null]);
  const to = r.rows.map(y => y.line_user_id);
  if (!to.length) return;
  const text = `🚨 มีคนแจ้งเหตุ รถ ${x.fleet_no}${x.route ? ` · สาย ${x.route.label}` : ""}\n"${x.text.length > 140 ? x.text.slice(0, 140) + "…" : x.text}"\n\nดูรายละเอียด: ${x.origin}/#${x.fleet_no}`;
  for (let i = 0; i < to.length; i += 500) await linePost("/v2/bot/message/multicast", { to: to.slice(i, i + 500), messages: [{ type: "text", text }] });
}

// ใช้รูปโปรไฟล์ที่แลกมาแล้ว
app.post("/api/me/avatar", requireAuth, wrap(async (req, res) => {
  const r = await pool.query(`UPDATE users u SET avatar = w.emoji, avatar_img = w.img FROM rewards w
    WHERE u.id = $1 AND w.id = $2 AND w.type = 'avatar' AND ${OWNS("w", "$1")} RETURNING u.avatar, u.avatar_img`, [req.user.sub, String(req.body.reward_id || "")]);
  if (!r.rowCount) throw forbidden(403, "ต้องแลกรูปนี้ก่อน");
  res.json(r.rows[0]);
}));

// ---------- แลกของ ----------
app.get("/api/rewards", optionalAuth, wrap(async (req, res) => {
  const r = await pool.query(`SELECT w.id, w.type, w.name, w.emoji, w.img, w.cost, ${OWNS("w", "$1")} AS owned
    FROM rewards w ORDER BY w.type DESC, w.cost = 0 DESC, w.cost, w.sort`, [req.user ? req.user.sub : null]);
  res.json({ items: r.rows });
}));

app.post("/api/rewards/:id/redeem", requireAuth, wrap(async (req, res) => {
  const uid = req.user.sub;
  const out = await tx(async c => {
    // ล็อกแถวผู้ใช้ → กดแลกพร้อมกันหลายแท็บก็ไม่ติดลบ
    const u = await c.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [uid]);
    if (!u.rowCount) throw new HttpError(401, "กรุณาเข้าสู่ระบบใหม่");
    const w = (await c.query("SELECT id, type, name, emoji, img, cost FROM rewards WHERE id = $1", [req.params.id])).rows[0];
    if (!w) throw new HttpError(404, "ไม่พบของชิ้นนี้");
    if (w.cost === 0) throw bad("ชิ้นนี้ฟรี ใช้ได้เลยไม่ต้องแลก");
    const have = (await c.query("SELECT 1 FROM user_rewards WHERE user_id = $1 AND reward_id = $2", [uid, w.id])).rowCount;
    if (have) throw new HttpError(409, "มีชิ้นนี้แล้ว");
    const bal = (await c.query("SELECT COALESCE(SUM(delta), 0)::int AS p FROM points_ledger WHERE user_id = $1", [uid])).rows[0].p;
    if (bal < w.cost) throw bad(`แต้มไม่พอ — ขาดอีก ${w.cost - bal} แต้ม`);
    await c.query("INSERT INTO user_rewards (user_id, reward_id) VALUES ($1, $2)", [uid, w.id]);
    await c.query("INSERT INTO points_ledger (user_id, delta, reason, note) VALUES ($1, $2, 'redeem', $3)", [uid, -w.cost, w.name]);
    return { reward: w, points: bal - w.cost };
  });
  res.status(201).json(out);
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
  // สายที่คนรีวิวว่าเจอคันนี้
  const routes = await pool.query(`SELECT route_id AS id, route_label AS label, count(*)::int AS n FROM reviews
    WHERE fleet_no = $1 AND status = 'visible' AND route_id IS NOT NULL GROUP BY 1, 2 ORDER BY n DESC, label LIMIT 6`, [f.fleet_no]);
  res.json({ fleet_no: f.fleet_no, zone: f.zone, model_id: f.model_id, stats: r.rows[0], routes: routes.rows });
}));

// ---------- สายรถเมล์ (GTFS ของ สนข.) ----------
app.get("/api/routes", wrap(async (_req, res) => {
  const r = await pool.query("SELECT id, no, old_no AS old, name, agency, kind FROM gtfs_routes ORDER BY NULLIF(old_no, '') IS NULL, old_no, no, id");
  res.set("Cache-Control", "public, max-age=3600").json({ items: r.rows });
}));
app.get("/api/routes/:id", wrap(async (req, res) => {
  const r = await pool.query("SELECT id, no, old_no AS old, name, agency, kind, dirs FROM gtfs_routes WHERE id = $1", [String(req.params.id).slice(0, 20)]);
  if (!r.rows.length) throw new HttpError(404, "ไม่พบสายนี้");
  const route = r.rows[0];
  const ids = [...new Set(route.dirs.flatMap(d => d.stops))];
  const st = await pool.query("SELECT id, name, lat, lon FROM gtfs_stops WHERE id = ANY($1)", [ids]);
  const byId = new Map(st.rows.map(x => [x.id, x]));
  route.dirs = route.dirs.map(d => ({ head: d.head, stops: d.stops.map(id => byId.get(id)).filter(Boolean) }));
  // คันที่มีคนรีวิวว่าวิ่งสายนี้
  const buses = await pool.query(`SELECT fleet_no, count(*)::int AS n,
      round(avg((stars_driving + stars_stops + stars_condition) / 3.0), 1)::float AS avg
    FROM reviews WHERE route_id = $1 AND status = 'visible' GROUP BY 1 ORDER BY n DESC, fleet_no LIMIT 30`, [route.id]);
  res.json({ ...route, buses: buses.rows });
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
    SELECT ${reviewCols("$2")}
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
  if (hasPhone(text)) throw bad("ห้ามใส่เบอร์โทรในรีวิว");
  const s = [star(b.stars_driving), star(b.stars_stops), star(b.stars_condition)];
  if (type === "review" && s.some(x => x === null)) throw bad("ให้ดาวให้ครบ 3 ด้าน");
  const stop = str(b.stop_name, 80) || null;
  if (stop && (hasBlocked(stop) || hasPhone(stop))) throw bad("ชื่อป้ายไม่ถูกต้อง");
  const time = typeof b.ride_time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.ride_time) ? b.ride_time : null;
  let route = null;
  if (b.route_id != null && b.route_id !== "") {
    const rr = await pool.query("SELECT id, COALESCE(NULLIF(old_no, ''), no) AS label FROM gtfs_routes WHERE id = $1", [String(b.route_id).slice(0, 20)]);
    if (!rr.rows.length) throw bad("ไม่พบสายนี้ — เลือกจากรายการ");
    route = rr.rows[0];
  }
  const uid = req.user.sub;

  const out = await tx(async c => {
    await c.query("INSERT INTO buses (fleet_no, zone, model_id) VALUES ($1, $2, $3) ON CONFLICT (fleet_no) DO NOTHING", [f.fleet_no, f.zone, f.model_id]);
    let r;
    try {
      r = await c.query(`INSERT INTO reviews (user_id, fleet_no, type, stars_driving, stars_stops, stars_condition, text, stop_name, ride_time, route_id, route_label)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [uid, f.fleet_no, type, ...(type === "review" ? s : [null, null, null]), text, stop, time, route && route.id, route && route.label]);
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
  if (type === "incident") notifyIncident({ fleet_no: f.fleet_no, route, text, author: uid, origin: process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}` })
    .catch(e => console.error("line notify:", e.message));
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

// กดสติกเกอร์ (ต้องแลกมาก่อน) · กดอันเดิมซ้ำ = ถอน · ไม่ให้แต้ม
app.post("/api/reviews/:id/react", requireAuth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sticker = String(req.body.sticker_id || "");
  if (!id) throw bad("รีวิวไม่ถูกต้อง");
  const uid = req.user.sub;
  const out = await tx(async c => {
    const rv = (await c.query("SELECT id FROM reviews WHERE id = $1 AND status = 'visible'", [id])).rows[0];
    if (!rv) throw new HttpError(404, "ไม่พบรีวิวนี้");
    const own = await c.query(`SELECT 1 FROM rewards w WHERE w.id = $2 AND w.type = 'sticker' AND ${OWNS("w", "$1")}`, [uid, sticker]);
    if (!own.rowCount) throw forbidden(403, "ต้องแลกสติกเกอร์นี้ที่ร้านก่อน");
    const del = await c.query("DELETE FROM review_reactions WHERE review_id = $1 AND user_id = $2 AND sticker_id = $3", [id, uid, sticker]);
    if (!del.rowCount) await c.query(`INSERT INTO review_reactions (review_id, user_id, sticker_id) VALUES ($1, $2, $3)
      ON CONFLICT (review_id, user_id) DO UPDATE SET sticker_id = EXCLUDED.sticker_id, created_at = now()`, [id, uid, sticker]);
    const r = await c.query(`SELECT COALESCE(json_agg(json_build_object('id', a.sticker_id, 'name', a.name, 'emoji', a.emoji, 'img', a.img, 'n', a.n) ORDER BY a.n DESC, a.sticker_id), '[]') AS reactions
      FROM (SELECT x.sticker_id, w.name, w.emoji, w.img, count(*)::int AS n FROM review_reactions x JOIN rewards w ON w.id = x.sticker_id
            WHERE x.review_id = $1 GROUP BY 1, 2, 3, 4) a`, [id]);
    return { id, reactions: r.rows[0].reactions, my_reaction: del.rowCount ? null : sticker };
  });
  res.json(out);
}));

// รายงานรีวิว · ครบ REPORT_AUTO_HIDE คน → ซ่อนไว้ก่อน รอ moderator ตัดสิน
app.post("/api/reviews/:id/report", requireAuth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = req.body.reason;
  if (!id) throw bad("รีวิวไม่ถูกต้อง");
  if (!REPORT_REASONS.includes(reason)) throw bad("เลือกเหตุผลที่รายงาน");
  const uid = req.user.sub;
  const out = await tx(async c => {
    const rv = (await c.query("SELECT id, user_id FROM reviews WHERE id = $1 AND status = 'visible' FOR UPDATE", [id])).rows[0];
    if (!rv) throw new HttpError(404, "ไม่พบรีวิวนี้");
    if (rv.user_id === uid) throw bad("รายงานรีวิวตัวเองไม่ได้");
    const ins = await c.query("INSERT INTO reports (review_id, reporter_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [id, uid, reason]);
    if (!ins.rowCount) throw new HttpError(409, "รายงานรีวิวนี้ไปแล้ว");
    const open = (await c.query("SELECT count(*)::int AS n FROM reports WHERE review_id = $1 AND status = 'open'", [id])).rows[0].n;
    const hidden = open >= REPORT_AUTO_HIDE;
    if (hidden) await c.query("UPDATE reviews SET status = 'hidden' WHERE id = $1", [id]);
    return { id, hidden };
  });
  res.status(201).json(out);
}));

// ---------- moderator ----------
app.get("/api/mod/reports", requireMod, wrap(async (_req, res) => {
  const r = await pool.query(`
    SELECT r.id, r.fleet_no, r.type, r.text, r.status, r.created_at, u.display_name, u.avatar, u.avatar_img,
           count(*)::int AS reports, json_agg(p.reason ORDER BY p.created_at) AS reasons, min(p.created_at) AS first_report
    FROM reports p JOIN reviews r ON r.id = p.review_id JOIN users u ON u.id = r.user_id
    WHERE p.status = 'open'
    GROUP BY r.id, u.id ORDER BY count(*) DESC, min(p.created_at) LIMIT 50`);
  res.json({ items: r.rows });
}));

// hide = ผิดกติกาจริง → ซ่อน + หักผู้เขียน −20 (ครั้งเดียวต่อรีวิว) · keep = ไม่ผิด → แสดงกลับ
app.post("/api/mod/reviews/:id/resolve", requireMod, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = req.body.action;
  if (!id || !["hide", "keep"].includes(action)) throw bad("action ต้องเป็น hide หรือ keep");
  const out = await tx(async c => {
    const rv = (await c.query("SELECT id, user_id FROM reviews WHERE id = $1 FOR UPDATE", [id])).rows[0];
    if (!rv) throw new HttpError(404, "ไม่พบรีวิวนี้");
    const upd = await c.query(`UPDATE reports SET status = $2, resolved_by = $3, resolved_at = now() WHERE review_id = $1 AND status = 'open'`,
      [id, action === "hide" ? "upheld" : "dismissed", req.user.sub]);
    if (!upd.rowCount) throw new HttpError(409, "ไม่มีรายงานค้างของรีวิวนี้");
    await c.query("UPDATE reviews SET status = $2 WHERE id = $1", [id, action === "hide" ? "hidden" : "visible"]);
    let penalty = 0;
    if (action === "hide") {
      const done = await c.query("SELECT 1 FROM points_ledger WHERE user_id = $1 AND reason = 'report_upheld' AND ref_id = $2", [rv.user_id, id]);
      if (!done.rowCount) { await addPoints(c, rv.user_id, PTS.report_upheld, "report_upheld", id); penalty = PTS.report_upheld; }
    }
    return { id, status: action === "hide" ? "hidden" : "visible", resolved: upd.rowCount, penalty };
  });
  res.json(out);
}));

app.get("/api/feed", optionalAuth, wrap(async (req, res) => {
  const sort = req.query.sort === "top" ? "r.helpful_count DESC, r.created_at DESC" : "r.created_at DESC";
  const typeFilter = req.query.type === "incident" ? "AND r.type = 'incident'" : "";
  const zone = /^[1-8]$/.test(req.query.zone || "") ? +req.query.zone : null;
  const me = req.user ? req.user.sub : null;
  const r = await pool.query(`
    SELECT ${reviewCols("$1")}
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
