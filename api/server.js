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
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "0";
const ACCESS_TTL = "15m", REFRESH_DAYS = 30;
// แจ้งเตือนทาง LINE Messaging API — เปิดเมื่อตั้งครบ 3 ค่า (ไม่ครบ = ปิดฟีเจอร์ ปุ่มติดตามไม่ขึ้น)
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_BOT_ID = process.env.LINE_BOT_ID || "";             // @xxxx ของ Official Account
const LINE_API = process.env.LINE_API_BASE || "https://api.line.me";
const LINE_ON = !!(LINE_SECRET && LINE_TOKEN && LINE_BOT_ID);
const MAX_FOLLOWS = 30;
// เข้าสู่ระบบด้วย LINE (LINE Login channel ใต้ provider เดียวกับบอท → userId ตรงกัน เชื่อมบอทให้อัตโนมัติ)
const LL_ID = process.env.LINE_LOGIN_CHANNEL_ID || "";
const LL_SECRET = process.env.LINE_LOGIN_CHANNEL_SECRET || "";
const LL_ON = !!(LL_ID && LL_SECRET);
const LL_WEB = process.env.LINE_LOGIN_WEB || "https://access.line.me";
const LL_API = process.env.LINE_LOGIN_API || "https://api.line.me";
const REFRESH_REUSE_GRACE_MS = process.env.REFRESH_GRACE_MS != null ? +process.env.REFRESH_GRACE_MS : 20000;

// ใช้ data.js ชุดเดียวกับหน้าเว็บ → จับคู่รุ่นรถจากเลขข้างรถ
const dataPath = [process.env.DATA_JS, path.join(__dirname, "data.js"), path.join(__dirname, "..", "data.js")].find(p => p && fs.existsSync(p));
const DATA = {};
vm.runInNewContext(fs.readFileSync(dataPath, "utf8") + "\nthis.MODELS = MODELS; this.ZONES = ZONES; this.LIVERY = LIVERY;", DATA);

// แต้ม (ค่าเริ่มต้น — ปรับได้หลังทดลองกับผู้ใช้)
const PTS = { signup: 20, review: 10, review_detail: 5, helpful_received: 2, helpful_daily_cap: 30, incident_confirmed: 20, incident_confirm_votes: 3, report_upheld: -20, route_tag: 2, route_tag_daily: 5, jury_majority: 3, jury_daily_cap: 15 };
const SEEN_DAYS = 60;   // สายที่เห็นรถคันนี้: นับเฉพาะช่วงนี้ (รถย้ายสายได้)
const REPORT_AUTO_HIDE = 3;   // report ที่ยังไม่ตัดสินครบเท่านี้ → ซ่อนไว้ก่อน แล้วเปิดคดีให้ลูกขุน
const REPORT_REASONS = ["spam", "rude", "personal", "fake"];
// ลูกขุนสุ่ม: 5 คน · 3 เสียงชนะ · 24 ชม. · คนหนึ่งค้างโหวตได้ไม่เกิน 3 คดี
// มีสิทธิ์ = บัญชีอายุ >= min_age_days วัน และมีรีวิวที่แสดงอยู่ (กันสมัครหลายบัญชีมารอถูกสุ่ม) · เดโมตั้ง JURY_MIN_AGE_DAYS=0
const JURY = { size: 5, win: 3, hours: 24, max_open: 3,
  min_age_days: process.env.JURY_MIN_AGE_DAYS != null ? +process.env.JURY_MIN_AGE_DAYS : 7, sweep_ms: +process.env.JURY_SWEEP_MS || 5 * 60e3 };
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
// แต้มจาก reason นี้ที่ได้ไปแล้ววันนี้ (เวลาไทย) · ใช้ทำเพดานต่อวัน
const pointsToday = async (c, userId, reason) => (await c.query(`SELECT COALESCE(SUM(delta), 0)::int AS s FROM points_ledger
  WHERE user_id = $1 AND reason = $2 AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok'`, [userId, reason])).rows[0].s;

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

app.get("/api/config", (_req, res) => res.json({ google_client_id: GOOGLE_CLIENT_ID || null, mock_login: MOCK_LOGIN, line: LINE_ON ? { bot_id: LINE_BOT_ID } : null, line_login: LL_ON }));

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
// บัญชีใหม่ (Google หรือ LINE) · รูปโปรไฟล์เริ่มต้นสุ่มจากรูปฟรี (เปลี่ยนเองได้ทันที) · +20 แต้ม
async function newUser(c, { email = null, name, google_sub = null, line_sub = null }) {
  const free = (await c.query("SELECT emoji, img FROM rewards WHERE type = 'avatar' AND cost = 0 ORDER BY random() LIMIT 1")).rows[0]
    || { emoji: AVATARS[Math.floor(Math.random() * AVATARS.length)], img: null };
  const u = (await c.query(`INSERT INTO users (email, display_name, avatar, avatar_img, google_sub, line_sub) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, display_name, avatar`, [email, name, free.emoji, free.img, google_sub, line_sub])).rows[0];
  await addPoints(c, u.id, PTS.signup, "signup");
  return u;
}

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
  const out = await tx(async c => {
    let r = await c.query("SELECT id, display_name, avatar FROM users WHERE google_sub = $1", [acc.sub]);
    if (!r.rowCount) {
      r = await c.query("UPDATE users SET google_sub = $1 WHERE email = $2 AND google_sub IS NULL RETURNING id, display_name, avatar", [acc.sub, acc.email]);
    }
    let created = false;
    if (!r.rowCount) { r = { rows: [await newUser(c, { email: acc.email, name, google_sub: acc.sub })] }; created = true; }
    await issueRefresh(c, res, r.rows[0].id);
    return { user: r.rows[0], created };
  });
  res.status(out.created ? 201 : 200).json({ token: signToken(out.user), ...out });
}));

// ---------- เข้าสู่ระบบด้วย LINE (OpenID Connect · ไม่ขออีเมล) ----------
// เริ่ม: สุ่ม state (กันปลอมคำขอ) + nonce (ผูก ID token กับคำขอนี้) เก็บใน cookie อายุ 10 นาที → ส่งไปหน้าอนุญาตของ LINE
// cookie ต้องเป็น SameSite=Lax เพราะ LINE ส่งผู้ใช้กลับมาแบบข้ามเว็บ
const LL_COOKIE = "bus_ll";
const llCookieOpts = { httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax", path: "/api/auth/line" };
const llCallback = req => publicOrigin(req) + "/api/auth/line/callback";
const backTo = (res, q) => res.redirect(302, "/?" + new URLSearchParams(q));
app.get("/api/auth/line", (req, res) => {
  if (!LL_ON) return backTo(res, { login_error: "ยังไม่เปิดเข้าสู่ระบบด้วย LINE" });
  const state = crypto.randomBytes(16).toString("base64url"), nonce = crypto.randomBytes(16).toString("base64url");
  res.cookie(LL_COOKIE, `${state}.${nonce}`, { ...llCookieOpts, maxAge: 600e3 });
  const q = new URLSearchParams({ response_type: "code", client_id: LL_ID, redirect_uri: llCallback(req), state, scope: "openid profile", nonce, bot_prompt: "normal" });
  res.redirect(302, `${LL_WEB}/oauth2/v2.1/authorize?${q}`);
});
app.get("/api/auth/line/callback", async (req, res) => {
  const [state, nonce] = String(readCookie(req, LL_COOKIE) || "").split(".");
  res.clearCookie(LL_COOKIE, llCookieOpts);
  try {
    if (!LL_ON) throw bad("ยังไม่เปิดเข้าสู่ระบบด้วย LINE");
    if (req.query.error) throw bad("ยกเลิกการเข้าสู่ระบบด้วย LINE แล้ว");
    if (!state || !nonce || req.query.state !== state || typeof req.query.code !== "string") throw bad("ลิงก์หมดอายุหรือไม่ถูกต้อง — กดเข้าสู่ระบบใหม่อีกครั้ง");
    const form = body => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), signal: AbortSignal.timeout(8000) });
    const tok = await fetch(`${LL_API}/oauth2/v2.1/token`, form({ grant_type: "authorization_code", code: req.query.code, redirect_uri: llCallback(req), client_id: LL_ID, client_secret: LL_SECRET }));
    if (!tok.ok) throw new Error("token " + tok.status);
    const { id_token } = await tok.json();
    // ให้ LINE ตรวจ ID token เอง (ลายเซ็น · aud · exp · nonce) แล้วเช็ก aud ซ้ำ
    const ver = await fetch(`${LL_API}/oauth2/v2.1/verify`, form({ id_token: String(id_token || ""), client_id: LL_ID, nonce }));
    if (!ver.ok) throw new Error("verify " + ver.status);
    const p = await ver.json();
    if (!p.sub || p.aud !== LL_ID || p.nonce !== nonce) throw new Error("id token claims");
    let name = String(p.name || "").trim().split(/\s+/)[0].slice(0, 30);   // ชื่อต้นเท่านั้น เหมือน Google
    if ([...name].length < 2 || hasBlocked(name)) name = "ผู้โดยสาร";
    const created = await tx(async c => {
      // เคยเข้าด้วย LINE · หรือบัญชี Google ที่เคยเชื่อมบอทด้วย LINE คนนี้ (userId เดียวกัน) → เข้าบัญชีเดิม แต้มไม่แยก
      let u = (await c.query("SELECT id FROM users WHERE line_sub = $1", [p.sub])).rows[0];
      if (!u) u = (await c.query("UPDATE users SET line_sub = $1 WHERE line_user_id = $1 AND line_sub IS NULL RETURNING id", [p.sub])).rows[0];
      const fresh = !u;
      if (fresh) u = await newUser(c, { name, line_sub: p.sub });
      await c.query("UPDATE users SET line_user_id = NULL WHERE line_user_id = $1 AND id <> $2", [p.sub, u.id]);
      await c.query("UPDATE users SET line_user_id = $1 WHERE id = $2", [p.sub, u.id]);   // เชื่อมบอทให้เลย
      await issueRefresh(c, res, u.id);
      return fresh;
    });
    backTo(res, created ? { login: "line", new: "1" } : { login: "line" });
  } catch (e) {
    if (!e.status) console.error("line login:", e.message);
    backTo(res, { login_error: e.status ? e.message : "เข้าสู่ระบบด้วย LINE ไม่สำเร็จ ลองใหม่อีกครั้ง" });
  }
});

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
  const [u, pts, ledger, cnt, owned, follows, jury] = await Promise.all([
    pool.query("SELECT id, email, display_name, avatar, avatar_img, role, created_at, line_user_id IS NOT NULL AS line_linked FROM users WHERE id = $1", [id]),
    pool.query("SELECT COALESCE(SUM(delta), 0)::int AS points FROM points_ledger WHERE user_id = $1", [id]),
    pool.query("SELECT delta, reason, ref_id, note, created_at FROM points_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 20", [id]),
    pool.query("SELECT count(*)::int AS reviews, COALESCE(SUM(helpful_count), 0)::int AS helpful FROM reviews WHERE user_id = $1 AND status = 'visible'", [id]),
    pool.query("SELECT reward_id FROM user_rewards WHERE user_id = $1 ORDER BY created_at", [id]),
    pool.query(`SELECT f.kind, f.target, COALESCE(NULLIF(g.old_no, ''), g.no, f.target) AS label, g.name FROM follows f
      LEFT JOIN gtfs_routes g ON f.kind = 'route' AND g.id = f.target WHERE f.user_id = $1 ORDER BY f.created_at DESC`, [id]),
    pool.query("SELECT count(*)::int AS jury FROM jury_seats s JOIN jury_cases k ON k.id = s.case_id WHERE s.user_id = $1 AND s.vote IS NULL AND k.status = 'open'", [id]),
  ]);
  if (!u.rowCount) throw new HttpError(401, "กรุณาเข้าสู่ระบบใหม่");
  res.json({ user: u.rows[0], points: pts.rows[0].points, ledger: ledger.rows, owned: owned.rows.map(x => x.reward_id), follows: follows.rows, ...cnt.rows[0], ...jury.rows[0] });
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
async function addFollow(uid, kind, raw) {
  const target = await followTarget(kind, raw);
  const n = await pool.query("SELECT count(*)::int AS n FROM follows WHERE user_id = $1", [uid]);
  if (n.rows[0].n >= MAX_FOLLOWS) throw bad(`ติดตามได้สูงสุด ${MAX_FOLLOWS} รายการ — เลิกติดตามอันเก่าที่แท็บ "ฉัน" ก่อน`);
  await pool.query("INSERT INTO follows (user_id, kind, target) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [uid, kind, target]);
}
app.post("/api/follows/:kind/:target", requireAuth, wrap(async (req, res) => {
  await addFollow(req.user.sub, req.params.kind, req.params.target);
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
  const origin = publicOrigin(req);
  for (const ev of events) await lineEvent(ev, origin).catch(e => console.error("line event:", e.message));
  res.json({ ok: true });
}
async function lineEvent(ev, origin) {
  const uid = ev.source && ev.source.type === "user" ? ev.source.userId : null;
  if (!uid) return;
  if (ev.type === "unfollow") return pool.query("UPDATE users SET line_user_id = NULL WHERE line_user_id = $1", [uid]);
  if (ev.type === "follow") return lineReply(ev.replyToken, "สวัสดีจาก คันนี้ดีไหม? 🚌\nพิมพ์เลขข้างรถ เช่น 7-3077 เพื่อดูคะแนนคันนั้น · พิมพ์ สาย 8 · หรือส่งตำแหน่งเพื่อดูป้ายใกล้ ๆ\n\nอยากรีวิว แจ้งเหตุ หรือรับแจ้งเตือน: ในเว็บไปที่แท็บ \"ฉัน\" กด \"เชื่อม LINE\" แล้วส่งรหัส 6 ตัวมาที่นี่");
  // รหัสเชื่อมบัญชี: ทั้งข้อความต้องเป็นรหัส (หรือ "เชื่อมบัญชี รหัส") — ไม่ให้คำอังกฤษในรีวิวถูกตีความเป็นรหัส
  const m = ev.type === "message" && ev.message && ev.message.type === "text"
    && String(ev.message.text).trim().toUpperCase().match(new RegExp(`^(?:เชื่อมบัญชี\\s*)?([${CODE_CHARS}]{6})$`));
  if (!m) return chatBot(ev, uid, origin);
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
  await multicast(to, [{ type: "text", text }]);
}

// แชตบอท: ค้นรถ/สาย/ป้ายใกล้ · รีวิว/แจ้งเหตุ/ติดตามผ่านปุ่ม (busRoutes ประกาศทีหลัง → ส่งเป็นฟังก์ชันห่อ)
const chatBot = require("./linebot")({ pool, linePost, parseFleet, DATA, busRoutes: (c, f) => busRoutes(c, f), createReview, addFollow, juryVote });

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
  res.json({ fleet_no: f.fleet_no, zone: f.zone, model_id: f.model_id, stats: r.rows[0], routes: await busRoutes(pool, f.fleet_no) });
}));

// สายที่คนเห็นรถคันนี้ใน SEEN_DAYS วันล่าสุด (กดบอกสาย + รีวิวที่เลือกสาย) · n = จำนวนคน
const SEEN = `(SELECT fleet_no, route_id, route_label, user_id, created_at FROM bus_route_sightings WHERE created_at > now() - interval '${SEEN_DAYS} days'
  UNION ALL SELECT fleet_no, route_id, route_label, user_id, created_at FROM reviews
    WHERE route_id IS NOT NULL AND status = 'visible' AND created_at > now() - interval '${SEEN_DAYS} days')`;
const busRoutes = async (c, fleet) => (await c.query(`SELECT route_id AS id, route_label AS label, count(DISTINCT user_id)::int AS n, max(created_at) AS last
  FROM ${SEEN} s WHERE fleet_no = $1 GROUP BY 1, 2 ORDER BY n DESC, last DESC LIMIT 6`, [fleet])).rows;

// บอกว่ารถคันนี้วิ่งสายอะไร (ไม่ต้องเขียนรีวิว) · +2 แต้ม วันละไม่เกิน 5 คัน · วันเดียวกันบอกซ้ำ = แก้สาย ไม่ได้แต้มเพิ่ม
app.post("/api/buses/:fleetNo/route", requireAuth, wrap(async (req, res) => {
  const f = parseFleet(req.params.fleetNo);
  if (!f) throw bad("เลขข้างรถไม่ถูกต้อง");
  const rr = await pool.query("SELECT id, COALESCE(NULLIF(old_no, ''), no) AS label FROM gtfs_routes WHERE id = $1", [String((req.body || {}).route_id || "").slice(0, 20)]);
  if (!rr.rowCount) throw bad("ไม่พบสายนี้ — เลือกจากรายการ");
  const route = rr.rows[0], uid = req.user.sub;
  const out = await tx(async c => {
    await c.query("INSERT INTO buses (fleet_no, zone, model_id) VALUES ($1, $2, $3) ON CONFLICT (fleet_no) DO NOTHING", [f.fleet_no, f.zone, f.model_id]);
    const ins = await c.query(`INSERT INTO bus_route_sightings (user_id, fleet_no, route_id, route_label) VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, fleet_no, seen_day) DO UPDATE SET route_id = EXCLUDED.route_id, route_label = EXCLUDED.route_label, created_at = now()
      RETURNING (xmax = 0) AS fresh`, [uid, f.fleet_no, route.id, route.label]);
    let earned = 0;
    if (ins.rows[0].fresh) {
      const today = await c.query(`SELECT count(*)::int AS n FROM points_ledger WHERE user_id = $1 AND reason = 'route_tag'
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok'`, [uid]);
      if (today.rows[0].n < PTS.route_tag_daily) { await addPoints(c, uid, PTS.route_tag, "route_tag"); earned = PTS.route_tag; }
    }
    return { earned, routes: await busRoutes(c, f.fleet_no) };
  });
  res.status(201).json(out);
}));

// ---------- สายรถเมล์ (GTFS ของ สนข.) ----------
app.get("/api/routes", wrap(async (_req, res) => {
  const r = await pool.query("SELECT id, no, old_no AS old, name, agency, kind FROM gtfs_routes ORDER BY NULLIF(old_no, '') IS NULL, old_no, no, id");
  res.set("Cache-Control", "public, max-age=3600").json({ items: r.rows });
}));
// ค้นสายจากชื่อป้าย/ย่าน เช่น "นางลิ้นจี่" → ทุกสายที่ผ่านป้ายนั้น · สะกดผิดได้ 1–2 ตัว (บางลิ้นจี่ → นางลิ้นจี่)
let stopIndex = null;   // [{ key, name, ids }] ชื่อป้ายไม่ซ้ำ · โหลดครั้งแรกที่ค้น (ข้อมูลเปลี่ยนเฉพาะตอน deploy ซึ่ง restart อยู่แล้ว)
const normTh = t => String(t).toLowerCase().replace(/[\s.()\-]/g, "");
// ระยะแก้ไขน้อยสุดระหว่าง q กับ "ส่วนใดส่วนหนึ่ง" ของ text (approximate substring)
function nearDist(q, text) {
  const a = [...q], b = [...text];
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.min(...prev);
}
app.get("/api/routes/search", wrap(async (req, res) => {
  const q = normTh(String(req.query.q || "").slice(0, 40));
  if ([...q].length < 2) return res.json({ near: false, stops: [], items: [] });
  if (!stopIndex) {
    const all = await pool.query("SELECT id, name FROM gtfs_stops");
    const by = new Map();
    for (const x of all.rows) { const k = normTh(x.name); if (!by.has(k)) by.set(k, { key: k, name: x.name, ids: [] }); by.get(k).ids.push(x.id); }
    stopIndex = [...by.values()];
  }
  let hits = stopIndex.filter(x => x.key.includes(q)).map(x => ({ ...x, d: 0 }));
  const len = [...q].length, near = !hits.length && len >= 4;
  if (near) {
    const k = len >= 9 ? 2 : 1;
    hits = stopIndex.map(x => ({ ...x, d: nearDist(q, x.key) })).filter(x => x.d <= k);
    const best = Math.min(...hits.map(x => x.d));
    hits = hits.filter(x => x.d === best);
  }
  hits = hits.slice(0, 150);
  if (!hits.length) return res.json({ near, stops: [], items: [] });
  const nameOf = new Map(hits.flatMap(x => x.ids.map(id => [id, x.name])));
  const r = await pool.query("SELECT route_id, stop_id FROM gtfs_route_stops WHERE stop_id = ANY($1)", [[...nameOf.keys()]]);
  const per = new Map();
  for (const x of r.rows) { if (!per.has(x.route_id)) per.set(x.route_id, new Set()); per.get(x.route_id).add(nameOf.get(x.stop_id)); }
  res.set("Cache-Control", "public, max-age=3600").json({ near, stops: [...new Set(hits.map(x => x.name))].slice(0, 5),
    items: [...per].map(([id, names]) => ({ id, stops: [...names].slice(0, 3) })) });
}));

app.get("/api/routes/:id", wrap(async (req, res) => {
  const r = await pool.query("SELECT id, no, old_no AS old, name, agency, kind, dirs FROM gtfs_routes WHERE id = $1", [String(req.params.id).slice(0, 20)]);
  if (!r.rows.length) throw new HttpError(404, "ไม่พบสายนี้");
  const route = r.rows[0];
  const ids = [...new Set(route.dirs.flatMap(d => d.stops))];
  const st = await pool.query("SELECT id, name, lat, lon FROM gtfs_stops WHERE id = ANY($1)", [ids]);
  const byId = new Map(st.rows.map(x => [x.id, x]));
  route.dirs = route.dirs.map(d => ({ head: d.head, stops: d.stops.map(id => byId.get(id)).filter(Boolean) }));
  // คันที่คนเห็นวิ่งสายนี้ + คะแนนเฉลี่ยของคันนั้น
  const buses = await pool.query(`SELECT s.fleet_no, count(DISTINCT s.user_id)::int AS n, max(s.created_at) AS last,
      (SELECT round(avg((stars_driving + stars_stops + stars_condition) / 3.0), 1)::float FROM reviews v
        WHERE v.fleet_no = s.fleet_no AND v.status = 'visible' AND v.type = 'review') AS avg
    FROM ${SEEN} s WHERE s.route_id = $1 GROUP BY 1 ORDER BY n DESC, last DESC LIMIT 30`, [route.id]);
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

// รีวิว / แจ้งเหตุ — ใช้ทั้งหน้าเว็บและแชต LINE (กติกาเดียวกัน)
async function createReview(uid, b, origin) {
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
  if (type === "incident") notifyIncident({ fleet_no: f.fleet_no, route, text, author: uid, origin })
    .catch(e => console.error("line notify:", e.message));
  return out;
}
const publicOrigin = req => process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
app.post("/api/reviews", requireAuth, wrap(async (req, res) => res.status(201).json(await createReview(req.user.sub, req.body || {}, publicOrigin(req)))));

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
    if (await pointsToday(c, rv.user_id, "helpful_received") + PTS.helpful_received <= PTS.helpful_daily_cap) await addPoints(c, rv.user_id, PTS.helpful_received, "helpful_received", id);
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

// รายงานรีวิว · ครบ REPORT_AUTO_HIDE คน → ซ่อนไว้ก่อน แล้วเปิดคดีให้ลูกขุน
app.post("/api/reviews/:id/report", requireAuth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = req.body.reason;
  if (!id) throw bad("รีวิวไม่ถูกต้อง");
  if (!REPORT_REASONS.includes(reason)) throw bad("เลือกเหตุผลที่รายงาน");
  const uid = req.user.sub;
  const out = await tx(async c => {
    const rv = (await c.query("SELECT id, user_id, fleet_no, text FROM reviews WHERE id = $1 AND status = 'visible' FOR UPDATE", [id])).rows[0];
    if (!rv) throw new HttpError(404, "ไม่พบรีวิวนี้");
    if (rv.user_id === uid) throw bad("รายงานรีวิวตัวเองไม่ได้");
    const ins = await c.query("INSERT INTO reports (review_id, reporter_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [id, uid, reason]);
    if (!ins.rowCount) throw new HttpError(409, "รายงานรีวิวนี้ไปแล้ว");
    const open = (await c.query("SELECT count(*)::int AS n FROM reports WHERE review_id = $1 AND status = 'open'", [id])).rows[0].n;
    const hidden = open >= REPORT_AUTO_HIDE;
    let jury = null;
    if (hidden) {
      await c.query("UPDATE reviews SET status = 'hidden' WHERE id = $1", [id]);
      jury = await openCase(c, rv);
    }
    return { id, hidden, jury };
  });
  if (out.jury) notifyJurors(out.jury, publicOrigin(req)).catch(e => console.error("line jury:", e.message));
  res.status(201).json({ id: out.id, hidden: out.hidden });
}));

// ---------- ลูกขุน (ทีมล่าแม่มด) ----------
// เปิดคดี: สุ่มจากคนที่ไม่ใช่ผู้เขียน ไม่ใช่คนรายงาน · ได้ไม่ถึง 5 คนก็เปิดด้วยเท่าที่มี (ครบเวลาไม่มีเสียง = พระเจ้าตัดสิน)
async function openCase(c, rv) {
  const k = (await c.query("INSERT INTO jury_cases (review_id, deadline) VALUES ($1, now() + make_interval(hours => $2)) RETURNING id",
    [rv.id, JURY.hours])).rows[0];
  await c.query("UPDATE reports SET case_id = $2 WHERE review_id = $1 AND status = 'open'", [rv.id, k.id]);
  const j = await c.query(`INSERT INTO jury_seats (case_id, user_id)
    SELECT $1, u.id FROM users u
    WHERE u.id <> $3
      AND NOT EXISTS (SELECT 1 FROM reports p WHERE p.review_id = $2 AND p.reporter_id = u.id)
      AND u.created_at <= now() - make_interval(days => $4)
      AND EXISTS (SELECT 1 FROM reviews r WHERE r.user_id = u.id AND r.status = 'visible')
      AND (SELECT count(*) FROM jury_seats s JOIN jury_cases o ON o.id = s.case_id WHERE s.user_id = u.id AND s.vote IS NULL AND o.status = 'open') < $5
    ORDER BY random() LIMIT $6
    RETURNING user_id`, [k.id, rv.id, rv.user_id, JURY.min_age_days, JURY.max_open, JURY.size]);
  return { id: k.id, fleet_no: rv.fleet_no, text: rv.text, jurors: j.rows.map(x => x.user_id) };
}
const tally = async (c, id) => (await c.query(`SELECT count(*) FILTER (WHERE vote = 'hide')::int AS hide,
  count(*) FILTER (WHERE vote = 'keep')::int AS keep, count(*) FILTER (WHERE vote IS NULL)::int AS pending FROM jury_seats WHERE case_id = $1`, [id])).rows[0];
// [ผล, ใครตัดสิน] หรือ null = ยังไม่จบ · final = หมดเวลาแล้ว
function verdictOf(t, final) {
  if (t.hide >= JURY.win) return ["hide", "jury"];
  if (t.keep >= JURY.win) return ["keep", "jury"];
  if (!final && t.pending) return null;
  if (t.hide !== t.keep) return [t.hide > t.keep ? "hide" : "keep", "jury"];
  return [crypto.randomInt(2) ? "hide" : "keep", "god"];   // เสมอหรือไม่มีใครโหวต: DEUS VULT
}
// ปิดคดี · ลูกขุนเผา = หักผู้เขียน −20 · พระเจ้าเผา = ซ่อนแต่ไม่หัก (เหรียญไม่ใช่หลักฐาน) · ลูกขุนฝั่งชนะ +3 (เพดานต่อวัน)
async function closeCase(c, id, outcome, by) {
  const reviewId = (await c.query("UPDATE jury_cases SET status = $2, decided_by = $3, closed_at = now() WHERE id = $1 RETURNING review_id",
    [id, outcome, by])).rows[0].review_id;
  const rv = (await c.query("UPDATE reviews SET status = $2 WHERE id = $1 RETURNING id, user_id, fleet_no",
    [reviewId, outcome === "hide" ? "hidden" : "visible"])).rows[0];
  await c.query("UPDATE reports SET status = $2, resolved_at = now() WHERE review_id = $1 AND status = 'open'", [rv.id, outcome === "hide" ? "upheld" : "dismissed"]);
  if (outcome === "hide" && by === "jury") {
    const done = await c.query("SELECT 1 FROM points_ledger WHERE user_id = $1 AND reason = 'report_upheld' AND ref_id = $2", [rv.user_id, rv.id]);
    if (!done.rowCount) await addPoints(c, rv.user_id, PTS.report_upheld, "report_upheld", rv.id);
  }
  if (by === "jury") {
    const won = await c.query("SELECT user_id FROM jury_seats WHERE case_id = $1 AND vote = $2", [id, outcome]);
    for (const w of won.rows)
      if (await pointsToday(c, w.user_id, "jury_majority") + PTS.jury_majority <= PTS.jury_daily_cap) await addPoints(c, w.user_id, PTS.jury_majority, "jury_majority", id);
  }
  return { id, fleet_no: rv.fleet_no, outcome, by, ...(await tally(c, id)) };
}
async function juryVote(uid, caseId, vote, origin) {
  if (!Number.isInteger(caseId) || caseId <= 0) throw bad("คดีไม่ถูกต้อง");
  if (!["hide", "keep"].includes(vote)) throw bad("โหวตได้แค่ เผา หรือ ปล่อย");
  const out = await tx(async c => {
    const k = (await c.query("SELECT status FROM jury_cases WHERE id = $1 FOR UPDATE", [caseId])).rows[0];
    if (!k) throw new HttpError(404, "ไม่พบคดีนี้");
    const seat = (await c.query("SELECT vote FROM jury_seats WHERE case_id = $1 AND user_id = $2", [caseId, uid])).rows[0];
    if (!seat) throw forbidden(403, "คุณไม่ได้เป็นลูกขุนคดีนี้");
    if (seat.vote) throw new HttpError(409, "โหวตคดีนี้ไปแล้ว");
    if (k.status !== "open") throw new HttpError(409, "คดีนี้ตัดสินไปแล้ว");
    await c.query("UPDATE jury_seats SET vote = $3, voted_at = now() WHERE case_id = $1 AND user_id = $2", [caseId, uid, vote]);
    const v = verdictOf(await tally(c, caseId), false);
    return { id: caseId, vote, closed: v ? await closeCase(c, caseId, ...v) : null };
  });
  if (out.closed) notifyVerdict(out.closed, origin).catch(e => console.error("line verdict:", e.message));
  return out;
}
// คดีที่หมดเวลา → ตัดสินด้วยเสียงที่มี หรือให้พระเจ้าโยนเหรียญ
async function sweepJury() {
  const due = await pool.query("SELECT id FROM jury_cases WHERE status = 'open' AND deadline <= now() ORDER BY deadline LIMIT 50");
  for (const { id } of due.rows) {
    const closed = await tx(async c => {
      const k = (await c.query("SELECT status FROM jury_cases WHERE id = $1 FOR UPDATE", [id])).rows[0];
      return k && k.status === "open" ? closeCase(c, id, ...verdictOf(await tally(c, id), true)) : null;
    });
    if (closed) notifyVerdict(closed).catch(e => console.error("line verdict:", e.message));
  }
}
setInterval(() => sweepJury().catch(e => console.error("jury sweep:", e.message)), JURY.sweep_ms);

const VERDICT_TXT = { hide: "🔥 เผา", keep: "🕊️ ปล่อย" };
const REPORT_TXT = { spam: "สแปม", rude: "หยาบคาย", personal: "ข้อมูลส่วนตัว", fake: "ไม่จริง" };
const lineIdsOf = async (sql, args) => (await pool.query(`SELECT u.line_user_id FROM users u WHERE u.line_user_id IS NOT NULL AND u.id IN (${sql})`, args)).rows.map(x => x.line_user_id);
async function multicast(to, messages) {
  for (let i = 0; i < to.length; i += 500) await linePost("/v2/bot/message/multicast", { to: to.slice(i, i + 500), messages });
}
async function notifyJurors(k, origin) {
  if (!LINE_ON || !k.jurors.length) return;
  const to = await lineIdsOf("SELECT unnest($1::int[])", [k.jurors]);
  if (!to.length) return;
  const rs = (await pool.query("SELECT reason, count(*)::int AS n FROM reports WHERE case_id = $1 GROUP BY 1 ORDER BY 2 DESC", [k.id])).rows;
  const q = (label, v) => ({ type: "action", action: { type: "postback", label, data: `a=jury&c=${k.id}&v=${v}`, displayText: label } });
  await multicast(to, [{ type: "text",
    text: `⚖️ คุณถูกสุ่มเป็นลูกขุน (ทีมล่าแม่มด)\nรีวิวรถ ${k.fleet_no}\n"${k.text.length > 200 ? k.text.slice(0, 200) + "…" : k.text}"\n\nถูกรายงานว่า: ${rs.map(r => `${REPORT_TXT[r.reason] || r.reason} ×${r.n}`).join(", ")}\nผิดกติกาไหม? โหวตได้ใน ${JURY.hours} ชม. โหวตตรงกับเสียงส่วนใหญ่ได้ +${PTS.jury_majority} แต้ม\nไม่มีใครโหวต พระเจ้าจะตัดสินเอง ⚔️\n\nดูในเว็บ: ${origin}/#jury`,
    quickReply: { items: [q("🔥 เผา (ผิดกติกา)", "hide"), q("🕊️ ปล่อย (ไม่ผิด)", "keep")] } }]);
}
async function notifyVerdict(v, origin = process.env.PUBLIC_URL || "") {
  if (!LINE_ON) return;
  const to = await lineIdsOf("SELECT user_id FROM jury_seats WHERE case_id = $1", [v.id]);
  if (!to.length) return;
  const head = v.by === "god"
    ? `⚖️ คดีรถ ${v.fleet_no}: ลูกขุนโหวตไม่ขาด (${v.hide}–${v.keep})\nพระเจ้าโยนเหรียญ… ออก ${VERDICT_TXT[v.outcome]}\n⚔️ DEUS VULT`
    : `⚖️ คำพิพากษา รถ ${v.fleet_no}: ${VERDICT_TXT[v.outcome]} ${v.hide}–${v.keep}\nใครโหวตตรงกับผลได้ +${PTS.jury_majority} แต้ม`;
  await multicast(to, [{ type: "text", text: head + (origin ? `\n\n${origin}/#verdicts` : "") }]);
}

// คดีที่ฉันเป็นลูกขุนและยังไม่ได้โหวต · ไม่บอกว่าใครรายงาน และไม่บอกเสียงคนอื่น
app.get("/api/jury", requireAuth, wrap(async (req, res) => {
  const r = await pool.query(`SELECT k.id, k.deadline, r.fleet_no, r.type, r.text, r.created_at,
      (SELECT COALESCE(json_object_agg(x.reason, x.n), '{}') FROM (SELECT reason, count(*)::int AS n FROM reports WHERE case_id = k.id GROUP BY 1) x) AS reasons,
      (SELECT count(*)::int FROM jury_seats WHERE case_id = k.id) AS seats
    FROM jury_seats s JOIN jury_cases k ON k.id = s.case_id JOIN reviews r ON r.id = k.review_id
    WHERE s.user_id = $1 AND s.vote IS NULL AND k.status = 'open' ORDER BY k.deadline`, [req.user.sub]);
  res.json({ items: r.rows, win: JURY.win });
}));
app.post("/api/jury/:id/vote", requireAuth, wrap(async (req, res) => {
  const out = await juryVote(req.user.sub, parseInt(req.params.id, 10), req.body.vote, publicOrigin(req));
  const c = out.closed;
  res.json({ id: out.id, vote: out.vote, closed: c ? { outcome: c.outcome, by: c.by, hide: c.hide, keep: c.keep } : null });
}));
// คำพิพากษา (สาธารณะ) · ลูกขุนเรียงตามชื่อ ไม่ผูกกับเสียง · เผาเพราะข้อมูลส่วนตัว = ไม่แสดงข้อความ
app.get("/api/verdicts", wrap(async (req, res) => {
  const f = req.query.fleet ? parseFleet(req.query.fleet) : null;
  if (req.query.fleet && !f) throw bad("เลขข้างรถไม่ถูกต้อง");
  const r = await pool.query(`SELECT k.id, k.status AS outcome, k.decided_by AS by, k.closed_at, r.fleet_no, r.type,
      CASE WHEN k.status = 'hide' AND EXISTS (SELECT 1 FROM reports p WHERE p.case_id = k.id AND p.reason = 'personal') THEN NULL ELSE r.text END AS text,
      (SELECT COALESCE(json_object_agg(x.reason, x.n), '{}') FROM (SELECT reason, count(*)::int AS n FROM reports WHERE case_id = k.id GROUP BY 1) x) AS reasons,
      (SELECT count(*)::int FROM jury_seats WHERE case_id = k.id AND vote = 'hide') AS hide,
      (SELECT count(*)::int FROM jury_seats WHERE case_id = k.id AND vote = 'keep') AS keep,
      (SELECT COALESCE(json_agg(json_build_object('display_name', u.display_name, 'avatar', u.avatar, 'avatar_img', u.avatar_img) ORDER BY u.display_name, u.id), '[]')
         FROM jury_seats s JOIN users u ON u.id = s.user_id WHERE s.case_id = k.id) AS jurors
    FROM jury_cases k JOIN reviews r ON r.id = k.review_id
    WHERE k.status <> 'open' AND ($1::text IS NULL OR r.fleet_no = $1)
    ORDER BY k.closed_at DESC LIMIT 30`, [f ? f.fleet_no : null]);
  res.json({ items: r.rows });
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
