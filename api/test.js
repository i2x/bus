// ทดสอบ API กับ PostgreSQL จริง (ฐานข้อมูลทิ้งได้ bus_test) — npm test
// เปิด server.js เป็น process แยก แล้วยิง HTTP ทุกกรณีที่ต้องผ่าน/ต้องถูกปฏิเสธ
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");
const { hasBlocked, hasPhone } = require("./wordfilter");

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}/api`;
const DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres:///bus_test";
let srv, pool, lineStub;
// LINE API ปลอม: เก็บทุก request ที่ server ส่งไปหา LINE
const LINE_SECRET = "s".repeat(32), lineCalls = [];

before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  lineStub = http.createServer((req, res) => {
    let b = ""; req.on("data", c => b += c);
    req.on("end", () => {
      const form = (req.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded");
      const body = form ? Object.fromEntries(new URLSearchParams(b)) : JSON.parse(b || "{}");
      lineCalls.push({ path: req.url, auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      // LINE Login: code "bad" = LINE ปฏิเสธ · อื่น ๆ → id token ที่บอก sub = code
      if (req.url === "/oauth2/v2.1/token") { res.statusCode = body.code === "bad" ? 400 : 200; return res.end(JSON.stringify({ id_token: "idt:" + body.code })); }
      if (req.url === "/oauth2/v2.1/verify") return res.end(JSON.stringify({ sub: body.id_token.slice(4), aud: body.client_id, nonce: body.nonce, name: "สมชาย ใจดี" }));
      res.end("{}");
    });
  }).listen(3998, "127.0.0.1");
  await pool.query("TRUNCATE users, buses, reviews, review_votes, points_ledger, user_rewards, review_reactions, reports, refresh_tokens RESTART IDENTITY CASCADE");
  srv = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, DATABASE_URL, PORT, HOST: "127.0.0.1", JWT_SECRET: "t".repeat(40), JURY_MIN_AGE_DAYS: "0", JURY_SWEEP_MS: "150",
      COOKIE_SECURE: "0", REFRESH_GRACE_MS: "1500", GOOGLE_CLIENT_ID: "",
      LINE_CHANNEL_SECRET: LINE_SECRET, LINE_CHANNEL_ACCESS_TOKEN: "test-token", LINE_BOT_ID: "@testbot", LINE_API_BASE: "http://127.0.0.1:3998",
      LINE_LOGIN_CHANNEL_ID: "llid", LINE_LOGIN_CHANNEL_SECRET: "llsecret", LINE_LOGIN_WEB: "http://127.0.0.1:3998", LINE_LOGIN_API: "http://127.0.0.1:3998" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(async () => { srv?.kill(); lineStub?.close(); await pool?.end(); });

// ---------- helpers ----------
async function call(method, p, { token, body, cookie } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  if (cookie) headers.cookie = cookie;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie") || "";
  const m = set.match(/bus_rt=([^;]*)/);
  return { status: r.status, body: await r.json(), cookie: m && m[1] ? "bus_rt=" + m[1] : null, setCookie: set };
}
const login = async (email, name = "ทดสอบ") => {
  const r = await call("POST", "/auth/google", { body: { email, name } });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  return { token: r.body.token, cookie: r.cookie, id: r.body.user.id, created: r.body.created };
};
const points = async u => (await call("GET", "/me", { token: u.token })).body.points;
const grant = (u, delta) => pool.query("INSERT INTO points_ledger (user_id, delta, reason) VALUES ($1, $2, 'test')", [u.id, delta]);
const review = (u, fleet_no, extra = {}) => call("POST", "/reviews", { token: u.token, body: {
  fleet_no, type: "review", stars_driving: 4, stars_stops: 3, stars_condition: 5, text: "แอร์เย็น ขับนิ่ม", ...extra } });

let A, B, C, D, M, aReview, bReview;

test("config: ยังไม่มี Google client ID → ใช้โหมดจำลอง", async () => {
  const r = await call("GET", "/config");
  assert.deepEqual(r.body, { google_client_id: null, mock_login: true, line: { bot_id: "@testbot" }, line_login: true });
});

test("เข้าสู่ระบบ: ครั้งแรก +20 · ได้ refresh cookie แบบ HttpOnly · อีเมลจริงถูกปฏิเสธในโหมดจำลอง", async () => {
  A = await login("alice@example.com", "Alice");
  assert.equal(A.created, true);
  assert.equal(await points(A), 20);
  const r = await call("POST", "/auth/google", { body: { email: "alice@example.com", name: "Alice" } });
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /HttpOnly/i);
  assert.match(r.setCookie, /SameSite=Strict/i);
  assert.match(r.setCookie, /Path=\/api\/auth/);
  assert.equal(await points(A), 20, "เข้าซ้ำไม่ได้แต้มซ้ำ");
  assert.equal((await call("POST", "/auth/google", { body: { email: "someone@gmail.com", name: "x y" } })).status, 400);
  B = await login("bob@example.com", "Bob");
  C = await login("carol@example.com", "Carol");
  D = await login("dave@example.com", "Dave");
  M = await login("mod@example.com", "Mod");
});

test("รีวิว: +10 +5 · รีวิวซ้ำวันเดียวกัน 409 · คำหยาบ/เบอร์โทร 400", async () => {
  let r = await review(A, "7-3077", { stop_name: "ฟิวเจอร์พาร์ค", ride_time: "08:15" });
  assert.equal(r.status, 201); assert.equal(r.body.earned, 15); aReview = r.body.id;
  assert.equal(await points(A), 35);
  assert.equal((await review(A, "7-3077")).status, 409);
  r = await review(B, "2-70235"); assert.equal(r.status, 201); assert.equal(r.body.earned, 10); bReview = r.body.id;
  assert.equal((await review(B, "1-1234", { text: "คนขับ เ หี้ ย มาก" })).status, 400);
  assert.equal((await review(B, "1-1234", { text: "ลืมของ โทร 081-234-5678" })).status, 400);
  assert.equal((await review(B, "1-1234", { text: "ok", stop_name: "f.u.c.k" })).status, 400);
});

test("word filter: จับแบบเลี่ยงตัวสะกด แต่ไม่จับคำปกติ", () => {
  for (const t of ["เหี้ยยยย", "ส ั ส", "f.u.c.k", "sh1t", "มึงขับดีๆ"]) assert.equal(hasBlocked(t), true, t);
  // ปิดตัวอักษรด้วย * · คำสั้นที่เว้นวรรคทีละตัว
  for (const t of ["f*ck", "sh*t", "f**king", "F * C K", "เหี้*", "ม ึ ง", "ม ึง ขับแย่", "ก.ู ไม่สน", "ขับดี แต่ ม ึ ง"]) assert.equal(hasBlocked(t), true, t);
  for (const t of ["****", "ให้ 5* เลย", "ดาว * * * *", "ร ถ ม า ช้ า", "ไป ก็ ได้"]) assert.equal(hasBlocked(t), false, t);
  assert.equal(hasBlocked("ขับโหดเหี้ยม"), false);
  assert.equal(hasBlocked("ใช้กูเกิลแมพดูสาย"), false);
  assert.equal(hasBlocked("แอร์เย็น คนขับใจดี"), false);
  assert.equal(hasPhone("โทร 0812345678"), true);
  assert.equal(hasPhone("+66 81 234 5678"), true);
  assert.equal(hasPhone("รถ 7-3077 สาย 8 ราคา 15 บาท"), false);
});

test("มีประโยชน์: +2 ให้ผู้เขียน · ซ้ำ 409 · กดของตัวเอง 400", async () => {
  assert.equal((await call("POST", `/reviews/${aReview}/helpful`, { token: B.token })).status, 200);
  assert.equal((await call("POST", `/reviews/${aReview}/helpful`, { token: B.token })).status, 409);
  assert.equal((await call("POST", `/reviews/${aReview}/helpful`, { token: A.token })).status, 400);
  assert.equal(await points(A), 37);
});

test("แลกของ: แต้มไม่พอ 400 · แลกได้หักแต้ม · ซ้ำ 409 · ledger บันทึก", async () => {
  let r = await call("POST", "/rewards/st-niulai/redeem", { token: A.token });
  assert.equal(r.status, 400); assert.match(r.body.error, /ขาดอีก 13/);
  r = await call("POST", "/rewards/st-yee/redeem", { token: A.token });
  assert.equal(r.status, 201); assert.equal(r.body.points, 17);
  assert.equal((await call("POST", "/rewards/st-yee/redeem", { token: A.token })).status, 409);
  assert.equal((await call("POST", "/rewards/nope/redeem", { token: A.token })).status, 404);
  assert.equal((await call("POST", "/rewards/st-yee/redeem")).status, 401);
  const me = (await call("GET", "/me", { token: A.token })).body;
  assert.equal(me.points, 17);
  assert.deepEqual(me.owned, ["st-yee"]);
  assert.deepEqual([me.ledger[0].delta, me.ledger[0].reason, me.ledger[0].note], [-20, "redeem", "Yee"]);
  const list = (await call("GET", "/rewards", { token: A.token })).body.items;
  assert.equal(list.find(x => x.id === "st-yee").owned, true);
  assert.equal(list.find(x => x.id === "st-67").owned, false);
});

test("แลกของ: กดพร้อมกัน 2 ชิ้นด้วยแต้มที่พอแค่ชิ้นเดียว → ได้ชิ้นเดียว แต้มไม่ติดลบ", async () => {
  const E = await login("eve@example.com", "Eve");   // 20 แต้ม
  const rs = await Promise.all(["st-yee", "st-ghost", "st-shh"].map(id => call("POST", `/rewards/${id}/redeem`, { token: E.token })));
  assert.deepEqual(rs.map(r => r.status).sort(), [201, 400, 400]);
  assert.equal(await points(E), 0);
});

test("รูปโปรไฟล์: ต้องแลกก่อน · แลกแล้วใช้ได้", async () => {
  assert.equal((await call("POST", "/me/avatar", { token: M.token, body: { reward_id: "av-frog" } })).status, 403);
  await grant(M, 100);
  assert.equal((await call("POST", "/rewards/av-frog/redeem", { token: M.token })).status, 201);
  assert.equal((await call("POST", "/me/avatar", { token: M.token, body: { reward_id: "st-yee" } })).status, 403);
  const r = await call("POST", "/me/avatar", { token: M.token, body: { reward_id: "av-frog" } });
  assert.equal(r.status, 200); assert.equal(r.body.avatar, "🐸"); assert.equal(r.body.avatar_img, "avatars/av-frog.webp");
});

test("ของฟรี: สติกเกอร์/รูปโปรไฟล์ราคา 0 ใช้ได้ทันที · แลกของฟรีไม่ได้ · สมัครใหม่ได้รูปฟรี", async () => {
  const list = (await call("GET", "/rewards", { token: C.token })).body.items;
  const freeSt = list.find(x => x.type === "sticker" && x.cost === 0), freeAv = list.find(x => x.type === "avatar" && x.cost === 0);
  assert.ok(freeSt && freeAv && freeSt.owned && freeAv.owned && freeSt.img);
  assert.equal(list.filter(x => x.cost === 0).length >= 12, true);
  assert.equal((await call("POST", `/rewards/${freeSt.id}/redeem`, { token: C.token })).status, 400);
  let r = await call("POST", `/reviews/${bReview}/react`, { token: C.token, body: { sticker_id: freeSt.id } });
  assert.equal(r.status, 200); assert.equal(r.body.reactions[0].img, freeSt.img);
  await call("POST", `/reviews/${bReview}/react`, { token: C.token, body: { sticker_id: freeSt.id } });
  r = await call("POST", "/me/avatar", { token: C.token, body: { reward_id: freeAv.id } });
  assert.equal(r.status, 200); assert.equal(r.body.avatar_img, freeAv.img);
  const me = (await call("GET", "/me", { token: C.token })).body.user;
  assert.equal(me.avatar_img, freeAv.img);
  const n = await login("newbie@example.com", "Newbie");
  assert.ok((await call("GET", "/me", { token: n.token })).body.user.avatar_img, "สมัครใหม่ได้รูปฟรีแบบสุ่ม");
});

test("สติกเกอร์: ต้องแลกก่อน · กดซ้ำ = ถอน · โชว์ในรายการรีวิว", async () => {
  assert.equal((await call("POST", `/reviews/${bReview}/react`, { token: C.token, body: { sticker_id: "st-yee" } })).status, 403);
  let r = await call("POST", `/reviews/${bReview}/react`, { token: A.token, body: { sticker_id: "st-yee" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.reactions, [{ id: "st-yee", name: "Yee", emoji: "🦖", img: "stickers/st-yee.webp", n: 1 }]);
  assert.equal(r.body.my_reaction, "st-yee");
  const list = (await call("GET", "/buses/2-70235/reviews", { token: A.token })).body.items;
  assert.equal(list[0].my_reaction, "st-yee");
  assert.equal(list[0].reactions[0].n, 1); assert.equal(list[0].reactions[0].name, "Yee");
  r = await call("POST", `/reviews/${bReview}/react`, { token: A.token, body: { sticker_id: "st-yee" } });
  assert.deepEqual(r.body.reactions, []); assert.equal(r.body.my_reaction, null);
  assert.equal(await points(B), 30, "สติกเกอร์ไม่ให้แต้ม");
});

test("สาย (GTFS): รายการสาย · ป้ายตามลำดับ · รีวิวผูกสาย · สายที่ไม่มีถูกปฏิเสธ", async () => {
  const list = (await call("GET", "/routes")).body.items;
  assert.ok(list.length > 300, "โหลดสายจาก routes.json แล้ว");
  const r8 = list.find(x => x.old === "8");
  assert.ok(r8 && r8.name.includes("สะพานพุทธ"));
  const d = (await call("GET", `/routes/${r8.id}`)).body;
  assert.ok(d.dirs.length >= 1 && d.dirs[0].stops.length > 10);
  assert.ok(d.dirs[0].stops.every(x => x.name && typeof x.lat === "number"));
  assert.equal((await call("GET", "/routes/nope")).status, 404);
  const R = await login("rider@example.com", "Rider");
  assert.equal((await review(R, "8-80040", { route_id: "nope" })).status, 400);
  assert.equal((await review(R, "8-80040", { route_id: r8.id, stop_name: d.dirs[0].stops[0].name })).status, 201);
  const bus = (await call("GET", "/buses/8-80040")).body;
  assert.deepEqual(bus.routes.map(({ id, label, n }) => ({ id, label, n })), [{ id: r8.id, label: "8", n: 1 }]);
  assert.equal((await call("GET", "/buses/8-80040/reviews")).body.items[0].route_label, "8");
  assert.deepEqual((await call("GET", `/routes/${r8.id}`)).body.buses.map(b => b.fleet_no), ["8-80040"]);
});

test("ค้นสายจากชื่อป้าย: ตรงตัว · สะกดผิด 1 ตัวก็เจอ (บางลิ้นจี่ → นางลิ้นจี่) · สั้นเกินไม่ค้น", async () => {
  const exact = (await call("GET", "/routes/search?q=" + encodeURIComponent("นางลิ้นจี่"))).body;
  assert.equal(exact.near, false);
  assert.ok(exact.items.length >= 5); assert.ok(exact.stops.includes("ตลาดนางลิ้นจี่"));
  assert.ok(exact.items.every(x => x.stops.every(n => n.includes("นางลิ้นจี่"))));
  const typo = (await call("GET", "/routes/search?q=" + encodeURIComponent("บาง ลิ้นจี่"))).body;
  assert.equal(typo.near, true);
  assert.deepEqual(typo.items.map(x => x.id).sort(), exact.items.map(x => x.id).sort());
  assert.deepEqual((await call("GET", "/routes/search?q=" + encodeURIComponent("ก"))).body.items, []);
  assert.deepEqual((await call("GET", "/routes/search?q=" + encodeURIComponent("ซซซซซซซ"))).body.items, []);
});

test("บอกสายของรถ: +2 แต้ม · วันเดียวกันบอกซ้ำ = แก้สาย ไม่ได้แต้มเพิ่ม · วันละ 5 คัน · นับรวมกับรีวิว", async () => {
  const items = (await call("GET", "/routes")).body.items;
  const r8 = items.find(x => x.old === "8"), r29 = items.find(x => x.old === "29");
  const T = await login("tagger@example.com", "Tagger");
  assert.equal((await call("POST", "/buses/8-80040/route", { body: { route_id: r8.id } })).status, 401);
  assert.equal((await call("POST", "/buses/8-80040/route", { token: T.token, body: { route_id: "nope" } })).status, 400);
  assert.equal((await call("POST", "/buses/xx/route", { token: T.token, body: { route_id: r8.id } })).status, 400);
  let r = await call("POST", "/buses/8-80040/route", { token: T.token, body: { route_id: r8.id } });
  assert.equal(r.status, 201); assert.equal(r.body.earned, 2);
  assert.deepEqual(r.body.routes.map(x => [x.label, x.n]), [["8", 2]], "รวมกับรีวิวของ rider ที่เลือกสาย 8 ไว้");
  r = await call("POST", "/buses/8-80040/route", { token: T.token, body: { route_id: r29.id } });
  assert.equal(r.body.earned, 0, "แก้สายวันเดียวกัน ไม่ได้แต้มเพิ่ม");
  assert.deepEqual(r.body.routes.map(x => [x.label, x.n]).sort(), [["29", 1], ["8", 1]]);
  for (const fl of ["7-3001", "7-3002", "7-3003", "7-3004", "7-3005"]) r = await call("POST", `/buses/${fl}/route`, { token: T.token, body: { route_id: r8.id } });
  assert.equal(r.body.earned, 0, "คันที่ 6 ของวัน ไม่ได้แต้ม");
  assert.equal(await points(T), 20 + 2 * 5);
  const d = (await call("GET", `/routes/${r8.id}`)).body;
  assert.ok(["7-3001", "7-3005", "8-80040"].every(f => d.buses.some(b => b.fleet_no === f)));
});

test("report: ตัวเอง 400 · ซ้ำ 409 · ครบ 3 คนซ่อนอัตโนมัติ + เปิดคดี", async () => {
  // คนที่มีสิทธิ์เป็นลูกขุน (มีรีวิวที่แสดงอยู่) ให้มีพอ 5 คน
  for (let i = 1; i <= 6; i++) assert.equal((await review(await login(`juror${i}@example.com`, `ลูกขุน${i}`), "3-1001")).status, 201);
  assert.equal((await call("POST", `/reviews/${aReview}/report`, { token: A.token, body: { reason: "spam" } })).status, 400);
  assert.equal((await call("POST", `/reviews/${aReview}/report`, { token: B.token, body: { reason: "whatever" } })).status, 400);
  let r = await call("POST", `/reviews/${aReview}/report`, { token: B.token, body: { reason: "rude" } });
  assert.equal(r.status, 201); assert.equal(r.body.hidden, false);
  assert.equal((await call("POST", `/reviews/${aReview}/report`, { token: B.token, body: { reason: "rude" } })).status, 409);
  const mine = (await call("GET", "/buses/7-3077/reviews", { token: B.token })).body.items[0];
  assert.equal(mine.reported, true);
  await call("POST", `/reviews/${aReview}/report`, { token: C.token, body: { reason: "fake" } });
  r = await call("POST", `/reviews/${aReview}/report`, { token: D.token, body: { reason: "spam" } });
  assert.equal(r.body.hidden, true);
  assert.equal((await call("GET", "/buses/7-3077/reviews")).body.items.length, 0);
  assert.equal((await call("GET", "/buses/7-3077")).body.stats.reviews, 0);
});

// ลูกขุนของคดีเป็นใคร: อ่านจาก DB แล้วเข้าสู่ระบบเป็นคนนั้น (บัญชีทดสอบทั้งหมด)
const caseOf = async reviewId => (await pool.query("SELECT id FROM jury_cases WHERE review_id = $1 ORDER BY id DESC LIMIT 1", [reviewId])).rows[0].id;
const jurorsOf = async id => Promise.all((await pool.query("SELECT u.email FROM jury_seats s JOIN users u ON u.id = s.user_id WHERE s.case_id = $1 ORDER BY u.id", [id]))
  .rows.map(x => login(x.email)));
const vote = (u, id, v) => call("POST", `/jury/${id}/vote`, { token: u.token, body: { vote: v } });
const expire = id => pool.query("UPDATE jury_cases SET deadline = now() - interval '1 minute' WHERE id = $1", [id]);
async function waitClosed(id) {
  for (let i = 0; i < 40; i++) {
    const k = (await pool.query("SELECT status, decided_by FROM jury_cases WHERE id = $1", [id])).rows[0];
    if (k.status !== "open") return k;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error("case not closed");
}
const verdict = async id => (await call("GET", "/verdicts")).body.items.find(x => x.id === id);
const juryPts = async id => (await pool.query("SELECT user_id FROM points_ledger WHERE reason = 'jury_majority' AND ref_id = $1 ORDER BY user_id", [id])).rows.map(x => x.user_id);

test("ลูกขุน: ไม่สุ่มคนเขียน/คนรายงาน · คนนอก 403 · โหวตซ้ำ 409 · โหวตลับ · 3 เสียงเผา → ซ่อน −20 ฝั่งชนะ +3 · คำพิพากษาไม่ผูกคนกับเสียง", async () => {
  const k = await caseOf(aReview);
  const J = await jurorsOf(k);
  assert.equal(J.length, 5);
  for (const u of [A, B, C, D]) assert.ok(!J.some(j => j.id === u.id), "คนเขียนและคนรายงานไม่เป็นลูกขุน");

  assert.equal((await call("GET", "/me", { token: J[0].token })).body.jury, 1);
  const mine = (await call("GET", "/jury", { token: J[0].token })).body;
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].id, k); assert.equal(mine.items[0].seats, 5);
  assert.deepEqual(mine.items[0].reasons, { rude: 1, fake: 1, spam: 1 });
  assert.ok(!/reporter|vote/.test(JSON.stringify(mine)), "ไม่บอกคนรายงาน ไม่บอกเสียง");
  assert.equal((await call("GET", "/jury")).status, 401);
  assert.equal((await vote(B, k, "hide")).status, 403);
  assert.equal((await vote(J[0], k, "burn")).status, 400);
  assert.equal((await vote(J[0], 999999, "hide")).status, 404);

  const aBefore = await points(A), jBefore = await Promise.all(J.map(points));
  assert.equal((await vote(J[0], k, "hide")).body.closed, null);
  assert.equal((await vote(J[1], k, "keep")).body.closed, null);
  assert.equal((await vote(J[1], k, "hide")).status, 409);
  assert.equal((await vote(J[2], k, "hide")).body.closed, null);
  assert.equal(await verdict(k), undefined, "ยังไม่ปิดคดี ไม่ประกาศ");
  assert.equal((await call("GET", "/jury", { token: J[0].token })).body.items.length, 0, "โหวตแล้วหายจากรายการ");
  const r = await vote(J[3], k, "hide");
  assert.deepEqual(r.body.closed, { outcome: "hide", by: "jury", hide: 3, keep: 1 });
  assert.equal((await vote(J[4], k, "keep")).status, 409, "คดีปิดแล้ว");

  assert.equal(await points(A), aBefore - 20);
  assert.deepEqual(await Promise.all(J.map(points)), jBefore.map((p, i) => p + ([0, 2, 3].includes(i) ? 3 : 0)));
  assert.equal((await call("GET", "/buses/7-3077/reviews")).body.items.length, 0);

  const v = await verdict(k);
  assert.equal(v.outcome, "hide"); assert.equal(v.by, "jury"); assert.equal(v.hide, 3); assert.equal(v.keep, 1);
  assert.equal(v.text, "แอร์เย็น ขับนิ่ม"); assert.equal(v.fleet_no, "7-3077");
  assert.equal(v.jurors.length, 5);
  const byName = (await pool.query("SELECT u.display_name FROM jury_seats s JOIN users u ON u.id = s.user_id WHERE s.case_id = $1 ORDER BY u.display_name, u.id", [k])).rows;
  assert.deepEqual(v.jurors.map(x => x.display_name), byName.map(x => x.display_name), "เรียงตามชื่อ ไม่ใช่ลำดับโหวต");
  assert.ok(!/"vote"|email|user_id/.test(JSON.stringify(v)));
  assert.equal((await call("GET", "/verdicts?fleet=7-3077")).body.items[0].id, k);
  assert.equal((await call("GET", "/verdicts?fleet=2-70235")).body.items.length, 0);
  assert.equal((await call("GET", "/verdicts?fleet=xx")).status, 400);
});

test("ลูกขุน: หมดเวลา เสียงมากกว่าชนะ · เผาเพราะข้อมูลส่วนตัวไม่โชว์ข้อความ · ไม่มีใครโหวต = พระเจ้าตัดสิน ไม่หักแต้ม · LINE แจ้งลูกขุน + โหวตในแชต", async () => {
  // ให้ทุกคนผูก LINE ไว้ (ชั่วคราว) เพื่อดูข้อความที่ส่ง
  await pool.query("UPDATE users SET line_user_id = 'Uj' || id WHERE line_user_id IS NULL");
  const hook = async events => {
    const body = JSON.stringify({ destination: "Ubot", events });
    await fetch(BASE + "/line/webhook", { method: "POST", body,
      headers: { "content-type": "application/json", "x-line-signature": crypto.createHmac("sha256", LINE_SECRET).update(body).digest("base64") } });
  };
  const waitLine = async re => {
    for (let i = 0; i < 40; i++) { const m = lineCalls.find(x => re.test(JSON.stringify(x.body))); if (m) return m; await new Promise(r => setTimeout(r, 25)); }
    throw new Error("no LINE message " + re);
  };
  const reportAll = (id, reason) => Promise.all([B, C, M].map(u => call("POST", `/reviews/${id}/report`, { token: u.token, body: { reason } })));

  // คดี 1: โหวต 1 เสียงทางแชต LINE แล้วหมดเวลา → ลูกขุนชนะ 1–0 · เหตุผลข้อมูลส่วนตัว → ไม่โชว์ข้อความ
  const Y = await login("leaky@example.com", "Leaky");
  const y = (await review(Y, "5-1234", { text: "คนขับชื่อสมศักดิ์ บ้านอยู่ซอย 5" })).body.id;
  lineCalls.length = 0;
  await reportAll(y, "personal");
  const k1 = await caseOf(y), J1 = await jurorsOf(k1);
  const sent = await waitLine(/ถูกสุ่มเป็นลูกขุน/);
  assert.equal(sent.path, "/v2/bot/message/multicast");
  assert.deepEqual([...sent.body.to].sort(), J1.map(j => "Uj" + j.id).sort());
  assert.match(sent.body.messages[0].text, /5-1234[\s\S]*ข้อมูลส่วนตัว ×3/);
  assert.deepEqual(sent.body.messages[0].quickReply.items.map(x => x.action.data), [`a=jury&c=${k1}&v=hide`, `a=jury&c=${k1}&v=keep`]);
  lineCalls.length = 0;
  await hook([{ type: "postback", replyToken: "rt", source: { type: "user", userId: "Uj" + J1[0].id }, postback: { data: `a=jury&c=${k1}&v=hide` } }]);
  assert.match((await waitLine(/บันทึกเสียงแล้ว/)).body.messages[0].text, /บันทึกเสียงแล้ว/);
  const yBefore = await points(Y);
  await expire(k1);
  assert.deepEqual({ ...(await waitClosed(k1)) }, { status: "hide", decided_by: "jury" });
  assert.equal(await points(Y), yBefore - 20);
  assert.deepEqual(await juryPts(k1), [J1[0].id]);
  const v1 = await verdict(k1);
  assert.equal(v1.text, null, "ข้อมูลส่วนตัวไม่เผยแพร่ซ้ำ"); assert.deepEqual(v1.reasons, { personal: 3 });
  assert.deepEqual([v1.hide, v1.keep], [1, 0]);

  // คดี 2: ไม่มีใครโหวต → พระเจ้าโยนเหรียญ · ไม่หักแต้ม ไม่มีใครได้แต้ม
  const X = await login("suspect@example.com", "Suspect");
  const x = (await review(X, "5-1235", { text: "รถมาช้ามาก" })).body.id;
  await reportAll(x, "fake");
  const k2 = await caseOf(x), xBefore = await points(X);
  lineCalls.length = 0;
  await expire(k2);
  const c2 = await waitClosed(k2);
  assert.equal(c2.decided_by, "god");
  assert.equal(await points(X), xBefore, "เหรียญไม่ใช่หลักฐาน ไม่หักแต้ม");
  assert.deepEqual(await juryPts(k2), []);
  const v2 = await verdict(k2);
  assert.equal(v2.by, "god"); assert.equal(v2.text, "รถมาช้ามาก"); assert.deepEqual([v2.hide, v2.keep], [0, 0]);
  assert.equal((await call("GET", "/buses/5-1235/reviews")).body.items.length, c2.status === "keep" ? 1 : 0);
  assert.match((await waitLine(/DEUS VULT/)).body.messages[0].text, /พระเจ้าโยนเหรียญ/);

  await pool.query("UPDATE users SET line_user_id = NULL WHERE line_user_id LIKE 'Uj%'");
});

test("แบ่งหน้า: feed / หน้ารถ / ศาลเตี้ย ไล่ cursor ได้ครบ ไม่ซ้ำ ไม่ข้าม · รีวิวใหม่ระหว่างเลื่อนไม่ทำให้ซ้ำ · cursor มั่ว 400", async () => {
  // ไล่ทุกหน้าด้วย limit เล็ก ๆ แล้วเทียบกับการขอทีเดียว
  const walk = async (path, limit) => {
    const ids = []; let next = null, pages = 0;
    do {
      const r = await call("GET", `${path}${path.includes("?") ? "&" : "?"}limit=${limit}${next ? "&before=" + next : ""}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.items.length <= limit);
      ids.push(...r.body.items.map(x => x.id)); next = r.body.next; pages++;
    } while (next && pages < 100);
    return { ids, pages };
  };
  for (const path of ["/feed", "/feed?sort=top", "/feed?type=incident", "/buses/3-1001/reviews", "/buses/3-1001/reviews?sort=helpful", "/verdicts"]) {
    const all = (await call("GET", `${path}${path.includes("?") ? "&" : "?"}limit=50`)).body;
    assert.equal(all.next, null, path + " ทั้งหมดอยู่ในหน้าเดียว");
    const { ids, pages } = await walk(path, 2);
    assert.deepEqual(ids, all.items.map(x => x.id), path);
    assert.equal(new Set(ids).size, ids.length, path + " ไม่ซ้ำ");
    if (all.items.length > 2) assert.ok(pages > 1, path + " แบ่งหลายหน้าจริง");
  }
  assert.equal((await call("GET", "/feed")).body.items.length <= 20, true, "ค่าเริ่ม 20 ต่อหน้า");
  assert.ok((await call("GET", "/feed?limit=999")).body.items.length <= 50, "ขอได้ไม่เกิน 50");

  // ระหว่างเลื่อน มีรีวิวใหม่เข้ามา → หน้าถัดไปยังต่อจากเดิม ไม่ได้แถวซ้ำ
  const p1 = (await call("GET", "/feed?limit=3")).body;
  const U = await login("latecomer@example.com", "มาทีหลัง");
  await review(U, "4-4444", { text: "รีวิวใหม่ระหว่างเลื่อน" });
  const p2 = (await call("GET", `/feed?limit=3&before=${p1.next}`)).body;
  assert.ok(!p2.items.some(x => p1.items.some(y => y.id === x.id)));
  assert.ok(new Date(p2.items[0].created_at) <= new Date(p1.items.at(-1).created_at));

  const bad = v => Buffer.from(JSON.stringify(v)).toString("base64url");
  for (const c of ["abc", bad(["2026-01-01 00:00:00+07"]), bad(["x'; DROP TABLE reviews; --", 1]), bad(["2026-01-01 00:00:00+07", "1"])])
    assert.equal((await call("GET", "/feed?before=" + c)).status, 400, c);
  assert.equal((await call("GET", "/feed?sort=top&before=" + bad(["2026-01-01 00:00:00+07", 1]))).status, 400, "top ต้องมี 3 ค่า");
  assert.equal((await call("GET", "/verdicts?before=abc")).status, 400);
});

test("refresh token: หมุนทุกครั้ง · เอาอันเก่ามาใช้ซ้ำ = เพิกถอนทั้งชุด · logout แล้วใช้ไม่ได้", async () => {
  assert.equal((await call("POST", "/auth/refresh")).status, 401);
  const u = await login("frank@example.com", "Frank");
  const r1 = await call("POST", "/auth/refresh", { cookie: u.cookie });
  assert.equal(r1.status, 200); assert.ok(r1.body.token); assert.ok(r1.cookie); assert.notEqual(r1.cookie, u.cookie);
  assert.equal((await call("GET", "/me", { token: r1.body.token })).status, 200);
  // 2 แท็บขอพร้อมกัน: ใช้ token เก่าภายในช่วงผ่อนผัน → ยังได้
  const r2 = await call("POST", "/auth/refresh", { cookie: u.cookie });
  assert.equal(r2.status, 200, "ช่วงผ่อนผัน");
  await new Promise(r => setTimeout(r, 1700));
  assert.equal((await call("POST", "/auth/refresh", { cookie: u.cookie })).status, 401, "ใช้ token เก่าซ้ำหลังช่วงผ่อนผัน");
  assert.equal((await call("POST", "/auth/refresh", { cookie: r2.cookie })).status, 401, "ทั้ง family ถูกเพิกถอน");

  const v = await login("frank@example.com", "Frank");
  const v2 = await call("POST", "/auth/refresh", { cookie: v.cookie });
  assert.equal((await call("POST", "/auth/logout", { cookie: v2.cookie })).status, 200);
  assert.equal((await call("POST", "/auth/refresh", { cookie: v2.cookie })).status, 401, "หลัง logout");
  assert.equal((await call("POST", "/auth/refresh", { cookie: v.cookie })).status, 401, "token ก่อนหน้าก็ใช้ไม่ได้หลัง logout");
  assert.equal((await call("GET", "/me", { token: "Bearer.x.y" })).status, 401);
});

test("ลบบัญชี: ข้อมูลหาย · token ใช้ไม่ได้ · จำนวนมีประโยชน์ของรีวิวคนอื่นลดตาม", async () => {
  assert.equal((await call("POST", `/reviews/${bReview}/helpful`, { token: D.token })).status, 200);
  assert.equal((await call("DELETE", "/me", { token: D.token })).status, 200);
  assert.equal((await call("GET", "/me", { token: D.token })).status, 401);
  const n = (await pool.query("SELECT count(*)::int AS n FROM users WHERE email = 'dave@example.com'")).rows[0].n;
  assert.equal(n, 0);
  const hc = (await pool.query("SELECT helpful_count FROM reviews WHERE id = $1", [bReview])).rows[0].helpful_count;
  assert.equal(hc, 0);
});

test("LINE: ลายเซ็นผิด 401 · ส่งรหัสให้บอท = เชื่อมบัญชี · ติดตามรถ/สาย · แจ้งเหตุแล้วส่งหาคนติดตาม ไม่ส่งหาคนแจ้ง", async () => {
  const hook = async (events, sig) => {
    const body = JSON.stringify({ destination: "Ubot", events });
    const r = await fetch(BASE + "/line/webhook", { method: "POST", body,
      headers: { "content-type": "application/json", "x-line-signature": sig ?? crypto.createHmac("sha256", LINE_SECRET).update(body).digest("base64") } });
    return r.status;
  };
  const waitCalls = async () => { for (let i = 0; i < 40 && !lineCalls.length; i++) await new Promise(r => setTimeout(r, 25)); };
  const msg = (text, userId = "Uf") => ({ type: "message", replyToken: "rt", source: { type: "user", userId }, message: { type: "text", text } });
  assert.equal(await hook([], "bad"), 401);
  assert.equal(await hook([]), 200, "ปุ่ม Verify ใน LINE Developers");

  const F = await login("follower@example.com", "Follower");
  const link = (await call("POST", "/me/line", { token: F.token })).body;
  assert.match(link.code, /^[A-Z2-9]{6}$/); assert.match(link.url, /^https:\/\/line\.me\/R\/oaMessage\/%40testbot\//);
  lineCalls.length = 0;
  assert.equal(await hook([msg("เชื่อมบัญชี " + link.code.toLowerCase())]), 200);
  assert.equal((await call("GET", "/me", { token: F.token })).body.user.line_linked, true);
  assert.equal(lineCalls[0].path, "/v2/bot/message/reply"); assert.match(lineCalls[0].body.messages[0].text, /Follower/);
  lineCalls.length = 0;
  await hook([msg(link.code, "Uother")]);
  assert.match(lineCalls[0].body.messages[0].text, /หมดอายุ/, "รหัสใช้ได้ครั้งเดียว");

  const r8 = (await call("GET", "/routes")).body.items.find(x => x.old === "8");
  assert.equal((await call("POST", "/follows/bus/7-3077", { token: F.token })).status, 201);
  assert.equal((await call("POST", `/follows/route/${r8.id}`, { token: F.token })).status, 201);
  assert.equal((await call("POST", "/follows/bus/xx", { token: F.token })).status, 400);
  assert.equal((await call("POST", "/follows/route/nope", { token: F.token })).status, 404);
  assert.equal((await call("POST", "/follows/bus/7-3077")).status, 401);
  assert.deepEqual((await call("GET", "/me", { token: F.token })).body.follows.map(f => f.label).sort(), ["7-3077", "8"]);

  const W = await login("witness@example.com", "Witness");
  lineCalls.length = 0;
  assert.equal((await call("POST", "/reviews", { token: W.token, body: { fleet_no: "1-46001", type: "incident", text: "รถเสียกลางทาง", route_id: r8.id } })).status, 201);
  await waitCalls();
  assert.equal(lineCalls.length, 1);
  assert.equal(lineCalls[0].path, "/v2/bot/message/multicast"); assert.equal(lineCalls[0].auth, "Bearer test-token");
  assert.deepEqual(lineCalls[0].body.to, ["Uf"]);
  assert.match(lineCalls[0].body.messages[0].text, /1-46001 · สาย 8[\s\S]*รถเสียกลางทาง[\s\S]*\/#1-46001/);

  lineCalls.length = 0;
  assert.equal((await call("POST", "/reviews", { token: F.token, body: { fleet_no: "7-3077", type: "incident", text: "แอร์รั่ว" } })).status, 201);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(lineCalls.length, 0, "ไม่ส่งหาคนแจ้งเอง");

  assert.equal((await call("DELETE", "/follows/bus/7-3077", { token: F.token })).status, 200);
  await hook([{ type: "unfollow", source: { type: "user", userId: "Uf" } }]);
  const me = (await call("GET", "/me", { token: F.token })).body;
  assert.equal(me.user.line_linked, false, "บล็อกบอท = ยกเลิกการเชื่อม");
  assert.deepEqual(me.follows.map(f => f.label), ["8"]);
});

test("LINE แชต: เลขข้างรถ · ไม่มีเขตให้เลือก · สาย · ตำแหน่ง → ป้ายใกล้ · ยังไม่เชื่อม = ขอให้เชื่อม · รีวิวทีละขั้น · ติดตาม · แจ้งเหตุ · แต้ม", async () => {
  const hook = async (events) => {
    const body = JSON.stringify({ destination: "Ubot", events });
    lineCalls.length = 0;
    const r = await fetch(BASE + "/line/webhook", { method: "POST", body,
      headers: { "content-type": "application/json", "x-line-signature": crypto.createHmac("sha256", LINE_SECRET).update(body).digest("base64") } });
    assert.equal(r.status, 200);
    const rep = lineCalls.find(c => c.path === "/v2/bot/message/reply");
    return rep ? rep.body.messages : [];
  };
  const say = (text, userId) => hook([{ type: "message", replyToken: "rt", source: { type: "user", userId }, message: { type: "text", text } }]);
  const tap = (data, userId) => hook([{ type: "postback", replyToken: "rt", source: { type: "user", userId }, postback: { data } }]);
  const all = m => JSON.stringify(m);
  const quick = m => m[0].quickReply.items.map(i => i.action);

  let m = await say("7-3077", "Uanon");
  assert.equal(m[0].type, "flex"); assert.match(all(m), /"7-3077"/); assert.match(all(m), /a=rate&bus=7-3077/);
  m = await say("7 3077", "Uanon");
  assert.equal(m[0].type, "flex", "เว้นวรรคแทนขีดได้");
  m = await say("80040", "Uanon");
  assert.ok(quick(m).some(a => a.text === "8-80040"), "ไม่มีเขต → ให้เลือก ไม่เดา");
  m = await say("สาย 8", "Uanon");
  assert.equal(m[0].contents.type, "carousel"); assert.match(all(m[0]), /สาย 8/); assert.match(all(m), /GTFS/);
  m = await say("สาย ไม่มีจริง", "Uanon");
  assert.match(m[0].text, /ไม่พบสาย/);
  m = await hook([{ type: "message", replyToken: "rt", source: { type: "user", userId: "Uanon" }, message: { type: "location", latitude: 13.74735, longitude: 100.49569 } }]);
  assert.match(all(m), /สวนสราญรมย์/); assert.match(all(m), /สาย /);
  m = await hook([{ type: "message", replyToken: "rt", source: { type: "user", userId: "Uanon" }, message: { type: "location", latitude: 0, longitude: 0 } }]);
  assert.match(m[0].text, /ไม่มีป้าย/);
  m = await tap("a=rate&bus=2-70235", "Uanon");
  assert.match(m[0].text, /เชื่อมบัญชี/, "ยังไม่เชื่อม → รีวิวไม่ได้");
  m = await say("อะไรก็ได้", "Uanon");
  assert.match(m[0].text, /เลขข้างรถ/);

  // เชื่อมบัญชี แล้วรีวิวทีละขั้น
  const C = await login("chat@example.com", "แชต");
  await say((await call("POST", "/me/line", { token: C.token })).body.code, "Uchat");
  const before = await points(C);
  m = await tap("a=rate&bus=2-70235", "Uchat");
  assert.match(m[0].text, /1\/3/); assert.equal(quick(m).length, 6);
  await tap("a=star&v=5", "Uchat"); await tap("a=star&v=4", "Uchat");
  m = await tap("a=star&v=3", "Uchat");
  assert.match(m[0].text, /พิมพ์รีวิว/);
  m = await say("STRESS แต่ขับนิ่ม", "Uchat");
  assert.match(m[0].text, /บันทึกรีวิว.*\+10/, "คำอังกฤษ 6 ตัวในรีวิวไม่ถูกตีความเป็นรหัสเชื่อมบัญชี");
  const rv = (await pool.query("SELECT stars_driving, stars_stops, stars_condition, text FROM reviews WHERE user_id = $1 AND fleet_no = '2-70235'", [C.id])).rows[0];
  assert.deepEqual(rv, { stars_driving: 5, stars_stops: 4, stars_condition: 3, text: "STRESS แต่ขับนิ่ม" });
  assert.equal(await points(C), before + 10);
  m = await tap("a=rate&bus=2-70235", "Uchat");
  assert.match(m[0].text, /รีวิวคันนี้ไปแล้ว/);
  m = await tap("a=star&v=5", "Uchat");
  assert.match(m[0].text, /หมดเวลา/, "ไม่มีขั้นตอนค้าง → กดดาวเก่าไม่มีผล");

  // ติดตาม + แจ้งเหตุจากแชต → ส่งหาคนติดตาม ไม่ส่งหาคนแจ้ง
  const D = await login("chatfollow@example.com", "ผู้ติดตาม");
  await say((await call("POST", "/me/line", { token: D.token })).body.code, "Udee");
  m = await tap("a=follow&kind=bus&t=2-70235", "Udee");
  assert.match(m[0].text, /ติดตามแล้ว/);
  assert.deepEqual((await call("GET", "/me", { token: D.token })).body.follows.map(f => f.label), ["2-70235"]);
  m = await tap("a=inc&bus=2-70235", "Uchat");
  assert.ok(quick(m).some(a => a.data.includes("k=breakdown")));
  m = await tap("a=inc_kind&bus=2-70235&k=breakdown", "Uchat");
  assert.match(m[0].text, /แจ้งเหตุรถ 2-70235 แล้ว/);
  for (let i = 0; i < 40 && !lineCalls.some(c => c.path.endsWith("multicast")); i++) await new Promise(r => setTimeout(r, 25));
  const mc = lineCalls.find(c => c.path.endsWith("multicast"));
  assert.deepEqual(mc.body.to, ["Udee"]); assert.match(mc.body.messages[0].text, /2-70235[\s\S]*รถเสีย/);

  // เล่าเหตุเอง: คำหยาบ → พิมพ์ใหม่ได้ในขั้นเดิม
  await tap("a=inc_kind&bus=2-70235&k=other", "Uchat");
  m = await say("คนขับเหี้ย", "Uchat");
  assert.match(m[0].text, /พิมพ์ใหม่/);
  m = await say("ควันดำเต็มรถ", "Uchat");
  assert.match(m[0].text, /แจ้งเหตุรถ 2-70235 แล้ว/);

  m = await say("แต้ม", "Uchat");
  assert.match(m[0].text, new RegExp(`แชต มี ${await points(C)} แต้ม[\\s\\S]*\\+10  เขียนรีวิว`));
  await tap("a=rate&bus=1-46001", "Uchat");
  m = await tap("a=cancel", "Uchat");
  assert.match(m[0].text, /ยกเลิก/);
  m = await say("ข้อความหลังยกเลิก", "Uchat");
  assert.match(m[0].text, /เลขข้างรถ/, "ยกเลิกแล้วข้อความต่อไปไม่ถูกบันทึกเป็นรีวิว");
});

test("เข้าสู่ระบบด้วย LINE: state ผิด/ยกเลิก/LINE ปฏิเสธ → กลับพร้อม error · ครั้งแรก +20 ไม่มีอีเมล เชื่อมบอทให้เลย · ครั้งต่อไปบัญชีเดิม · เคยเชื่อมบอทจากบัญชี Google → เข้าบัญชี Google เดิม", async () => {
  const start = async () => {
    const r = await fetch(BASE + "/auth/line", { redirect: "manual" });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get("location")), ck = r.headers.get("set-cookie").match(/bus_ll=([^;]+)/)[1];
    return { loc, ck };
  };
  const back = async (q, ck) => {
    const r = await fetch(BASE + "/auth/line/callback?" + new URLSearchParams(q), { redirect: "manual", headers: ck ? { cookie: "bus_ll=" + ck } : {} });
    assert.equal(r.status, 302);
    const m = (r.headers.get("set-cookie") || "").match(/bus_rt=([^;]+)/);
    return { to: new URL(r.headers.get("location"), "http://x").searchParams, cookie: m ? "bus_rt=" + m[1] : null };
  };
  const session = async cookie => (await call("POST", "/auth/refresh", { cookie })).body.token;

  assert.equal((await call("GET", "/config")).body.line_login, true);
  const { loc, ck } = await start();
  assert.equal(loc.pathname, "/oauth2/v2.1/authorize");
  assert.equal(loc.searchParams.get("client_id"), "llid");
  assert.equal(loc.searchParams.get("scope"), "openid profile", "ไม่ขออีเมล");
  assert.equal(loc.searchParams.get("redirect_uri"), "http://127.0.0.1:3999/api/auth/line/callback");
  const [state, nonce] = decodeURIComponent(ck).split(".");
  assert.equal(loc.searchParams.get("state"), state); assert.equal(loc.searchParams.get("nonce"), nonce);

  let b = await back({ code: "Unew", state: "ปลอม" }, ck);
  assert.match(b.to.get("login_error"), /หมดอายุ|ไม่ถูกต้อง/); assert.equal(b.cookie, null);
  b = await back({ code: "Unew", state });
  assert.ok(b.to.get("login_error"), "ไม่มี cookie (อีกเบราว์เซอร์) = ไม่ผ่าน");
  b = await back({ error: "access_denied", state }, ck);
  assert.match(b.to.get("login_error"), /ยกเลิก/);
  b = await back({ code: "bad", state }, ck);
  assert.match(b.to.get("login_error"), /ไม่สำเร็จ/);

  lineCalls.length = 0;
  b = await back({ code: "Unew", state }, ck);
  assert.equal(b.to.get("login"), "line"); assert.equal(b.to.get("new"), "1");
  assert.equal(lineCalls.find(c => c.path === "/oauth2/v2.1/verify").body.nonce, nonce, "ส่ง nonce ให้ LINE ตรวจ");
  assert.equal(lineCalls.find(c => c.path === "/oauth2/v2.1/token").body.client_secret, "llsecret");
  const L = { token: await session(b.cookie) };
  const me = (await call("GET", "/me", { token: L.token })).body;
  assert.equal(me.user.email, null); assert.equal(me.user.display_name, "สมชาย", "ชื่อต้นเท่านั้น");
  assert.equal(me.user.line_linked, true, "เชื่อมบอทให้อัตโนมัติ"); assert.equal(me.points, 20);

  const again = await start();
  b = await back({ code: "Unew", state: decodeURIComponent(again.ck).split(".")[0] }, again.ck);
  assert.equal(b.to.get("new"), null);
  assert.equal((await call("GET", "/me", { token: await session(b.cookie) })).body.user.id, me.user.id, "ครั้งต่อไปได้บัญชีเดิม");

  // บัญชี Google ที่เคยเชื่อมบอทด้วยรหัส 6 ตัว → เข้าด้วย LINE ได้บัญชีเดียวกัน
  const G = await login("googlefirst@example.com", "กูเกิล");
  await pool.query("UPDATE users SET line_user_id = 'Ugoogle' WHERE id = $1", [G.id]);
  const s3 = await start();
  b = await back({ code: "Ugoogle", state: decodeURIComponent(s3.ck).split(".")[0] }, s3.ck);
  assert.equal(b.to.get("new"), null);
  const gm = (await call("GET", "/me", { token: await session(b.cookie) })).body;
  assert.equal(gm.user.id, G.id); assert.equal(gm.user.email, "googlefirst@example.com");
});
