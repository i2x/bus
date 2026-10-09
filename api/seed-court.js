// ข้อมูลตัวอย่างของศาลเตี้ยสำหรับเดโม: ผู้ใช้ทดสอบ 10 คน + คดีที่ปิดแล้ว 6 คดี + คดีที่ยังเปิดให้บัญชีเดโมโหวต
//   DATABASE_URL=... node seed-court.js           ลบของ seed เดิมแล้วสร้างใหม่ (รันซ้ำได้)
//   DATABASE_URL=... node seed-court.js --clean   ลบอย่างเดียว
// เขียนลง DB ตรง ๆ ในกติกาเดียวกับ server (หักแต้ม −20 เมื่อลูกขุนเผา, ลูกขุนฝั่งชนะ +3, พระเจ้าตัดสินไม่ให้/ไม่หักแต้ม)
// ไม่สุ่มลูกขุนจากผู้ใช้จริง และไม่ส่ง LINE หาใคร · ผู้ใช้ seed ใช้อีเมล seed-court-N@example.com ทั้งหมด
const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SEED = "seed-court-%@example.com";
const NAMES = ["มิ้นท์", "ปั้น", "เฟิร์น", "บอส", "แพร", "ภูมิ", "ใบเตย", "กาย", "ข้าวหอม", "ต้นกล้า"];
// รีวิวปกติของผู้ใช้ seed (ทำให้มีสิทธิ์เป็นลูกขุนในคดีจริงต่อไปด้วย)
const NORMAL = [
  ["7-3077", "แอร์เย็น คนขับจอดชิดป้าย"], ["2-70235", "รถใหม่ เบาะสะอาด"], ["8-80040", "มาตรงเวลา ขับนิ่ม"], ["1-46001", "รถเก่าไปหน่อย แต่คนขับใจดี"],
  ["3-1001", "จอดเลยป้ายนิดนึง"], ["4-4444", "พัดลมเสียงดังแต่โอเค"], ["5-1234", "กระเป๋ารถทอนเงินถูก"], ["6-5678", "ขึ้นง่าย พื้นต่ำ"],
  ["7-3078", "ขับเร็วไปหน่อยตอนกลางคืน"], ["2-70236", "ไฟในรถสว่าง ปลอดภัยดี"],
];
// คดี: a = คนเขียน, rep = [คนรายงาน, เหตุผล], j = ลูกขุน (index ใน NAMES หรือ email บัญชีเดโม), v = เสียงตามลำดับ (null = ไม่ได้โหวต)
// out = ผล · by = jury | god (god: โยนเหรียญจริงตอน seed) · ago = ปิดคดีกี่นาทีที่แล้ว (null = ยังเปิดอยู่)
const CASES = [
  { fleet: "7-3077", a: 0, text: "คนขับหน้าเหมือนลิง ขับก็แย่ ไม่น่าให้มาขับรถ", rep: [[1, "rude"], [2, "rude"], [3, "rude"]],
    j: [4, 5, 6, 7, 8], v: ["hide", "keep", "hide", "hide", null], out: "hide", by: "jury", ago: 120 },
  { fleet: "2-70235", a: 1, text: "แอร์ไม่เย็นเลย ร้อนจนเหงื่อแตก", rep: [[0, "fake"], [2, "fake"], [3, "spam"]],
    j: [4, 5, 6, 7, 9], v: ["keep", "hide", "keep", "keep", null], out: "keep", by: "jury", ago: 300 },
  { fleet: "8-80040", a: 2, text: "คนขับชื่อสมชาย บ้านอยู่แถวบางกะปิ ใจร้อนมาก", rep: [[0, "personal"], [1, "personal"], [3, "personal"]],
    j: [4, 5, 6, 8, 9], v: ["hide", "hide", "hide", null, null], out: "hide", by: "jury", ago: 1440 },
  { fleet: "3-1001", a: 3, text: "รับทำเว็บไซต์ราคาถูก ทักไลน์มาเลย", rep: [[0, "spam"], [1, "spam"], [2, "spam"]],
    j: [5, 6, 7, 8, 9], v: ["hide", "hide", "hide", null, null], out: "hide", by: "jury", ago: 2880 },
  { fleet: "4-4444", a: 4, text: "รถคันนี้วิ่งเร็วเหมือนชินคันเซ็น", rep: [[0, "fake"], [1, "fake"], [2, "fake"]],
    j: [3, 5, 6, 7, 8], v: [null, null, null, null, null], by: "god", ago: 30 },
  { fleet: "5-1234", a: 5, text: "คนขับเปิดเพลงลูกทุ่งดังมาก แต่เพราะดี", rep: [[0, "rude"], [1, "fake"], [2, "fake"]],
    j: [3, 4, 6, 7, 8], v: ["hide", "keep", null, null, null], by: "god", ago: 180 },
  // ยังเปิดอยู่: บัญชีเดโมเข้าสู่ระบบแล้วจะเห็นการ์ดลูกขุน · มีเสียงแล้ว 1–1 ให้เดโมโหวตต่อ
  { fleet: "6-5678", a: 6, text: "ประตูหลังปิดไม่สนิท ลมเข้าตลอดทาง", rep: [[0, "fake"], [1, "fake"], [2, "rude"]],
    j: [7, 8, "demo-fon@example.com", "demo-ton@example.com", "demo-ploy@example.com"], v: ["hide", "keep", null, null, null], ago: null },
];
const DEMO = { "demo-fon@example.com": "ฝน", "demo-ton@example.com": "ต้น", "demo-ploy@example.com": "Ploy" };

async function freeAvatar(c) {
  return (await c.query("SELECT emoji, img FROM rewards WHERE type = 'avatar' AND cost = 0 ORDER BY random() LIMIT 1")).rows[0] || { emoji: "🙂", img: null };
}
async function addUser(c, email, name, daysAgo) {
  const av = await freeAvatar(c);
  const u = (await c.query(`INSERT INTO users (email, google_sub, display_name, avatar, avatar_img, created_at)
    VALUES ($1, 'mock:' || $1, $2, $3, $4, now() - make_interval(days => $5)) RETURNING id`, [email, name, av.emoji, av.img, daysAgo])).rows[0].id;
  await c.query("INSERT INTO points_ledger (user_id, delta, reason, created_at) VALUES ($1, 20, 'signup', now() - make_interval(days => $2))", [u, daysAgo]);
  return u;
}
async function addReview(c, uid, fleet, text, minsAgo) {
  await c.query("INSERT INTO buses (fleet_no, zone) VALUES ($1, $2) ON CONFLICT (fleet_no) DO NOTHING", [fleet, +fleet[0]]);
  const id = (await c.query(`INSERT INTO reviews (user_id, fleet_no, type, stars_driving, stars_stops, stars_condition, text, created_at, created_day)
    VALUES ($1, $2, 'review', 4, 3, 4, $3, now() - make_interval(mins => $4), ((now() - make_interval(mins => $4)) AT TIME ZONE 'Asia/Bangkok')::date)
    RETURNING id`, [uid, fleet, text, minsAgo])).rows[0].id;
  await c.query("INSERT INTO points_ledger (user_id, delta, reason, ref_id, created_at) VALUES ($1, 10, 'review', $2, now() - make_interval(mins => $3))", [uid, id, minsAgo]);
  return id;
}

(async () => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // ลบของเดิม: ผู้ใช้ seed → รีวิว รายงาน คดี เสียง แต้ม ลบตามด้วย ON DELETE CASCADE
    const old = await c.query("DELETE FROM users WHERE email LIKE $1", [SEED]);
    if (process.argv.includes("--clean")) { await c.query("COMMIT"); console.log(`ลบผู้ใช้ seed ${old.rowCount} คน`); return; }

    const ids = [];
    for (const [i, name] of NAMES.entries()) {
      ids.push(await addUser(c, `seed-court-${i + 1}@example.com`, name, 30));
      await addReview(c, ids[i], NORMAL[i][0], NORMAL[i][1], 60 * 24 * 7 + i * 90);
    }
    // บัญชีเดโมที่ยังไม่เคยเข้าสู่ระบบ → สร้างให้ (เข้าด้วยโหมดจำลองแล้วจะได้บัญชีนี้)
    const who = async x => {
      if (typeof x === "number") return ids[x];
      const r = await c.query("SELECT id FROM users WHERE email = $1", [x]);
      return r.rowCount ? r.rows[0].id : addUser(c, x, DEMO[x], 1);
    };

    const summary = [];
    for (const k of CASES) {
      const opened = (k.ago ?? 0) + 600;   // เปิดคดีก่อนปิด 10 ชม.
      const rid = await addReview(c, ids[k.a], k.fleet, k.text, opened + 60);
      const cid = (await c.query(`INSERT INTO jury_cases (review_id, deadline, created_at) VALUES ($1, now() - make_interval(mins => $2) + interval '24 hours',
        now() - make_interval(mins => $2)) RETURNING id`, [rid, opened])).rows[0].id;
      for (const [u, reason] of k.rep)
        await c.query("INSERT INTO reports (review_id, reporter_id, reason, case_id, created_at) VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5))",
          [rid, ids[u], reason, cid, opened + 30]);
      const jurors = [];
      for (const [i, x] of k.j.entries()) {
        const uid = await who(x); jurors.push(uid);
        await c.query("INSERT INTO jury_seats (case_id, user_id, vote, voted_at) VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() - make_interval(mins => $4) END)",
          [cid, uid, k.v[i], opened - 60 * (i + 1)]);
      }
      if (k.ago == null) { await c.query("UPDATE reviews SET status = 'hidden' WHERE id = $1", [rid]); summary.push(`#${cid} ${k.fleet} ยังเปิด`); continue; }

      const out = k.by === "god" ? (crypto.randomInt(2) ? "hide" : "keep") : k.out;
      await c.query("UPDATE jury_cases SET status = $2, decided_by = $3, closed_at = now() - make_interval(mins => $4) WHERE id = $1", [cid, out, k.by, k.ago]);
      await c.query("UPDATE reviews SET status = $2 WHERE id = $1", [rid, out === "hide" ? "hidden" : "visible"]);
      await c.query("UPDATE reports SET status = $2, resolved_at = now() - make_interval(mins => $3) WHERE case_id = $1",
        [cid, out === "hide" ? "upheld" : "dismissed", k.ago]);
      if (k.by === "jury") {
        if (out === "hide") await c.query("INSERT INTO points_ledger (user_id, delta, reason, ref_id) VALUES ($1, -20, 'report_upheld', $2)", [ids[k.a], rid]);
        for (const [i, uid] of jurors.entries())
          if (k.v[i] === out) await c.query("INSERT INTO points_ledger (user_id, delta, reason, ref_id) VALUES ($1, 3, 'jury_majority', $2)", [uid, cid]);
      }
      summary.push(`#${cid} ${k.fleet} ${k.by === "god" ? "พระเจ้า" : "ลูกขุน"} ${out === "hide" ? "เผา" : "ปล่อย"}`);
    }
    await c.query("COMMIT");
    console.log(`ลบผู้ใช้ seed เดิม ${old.rowCount} คน · สร้างใหม่ ${ids.length} คน\n` + summary.join("\n"));
  } catch (e) { await c.query("ROLLBACK"); throw e; }
  finally { c.release(); await pool.end(); }
})().catch(e => { console.error(e.message); process.exit(1); });
