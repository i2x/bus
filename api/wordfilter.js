// กรองคำหยาบ + ข้อมูลส่วนบุคคลแบบเบื้องต้น ไม่ได้กันได้ทุกแบบ (คำใหม่/สแลงหลุดได้) ที่หลุดไปให้ผู้ใช้ report แล้วลูกขุนตัดสิน
// 3 ชั้น:
//   1) normalize แล้วหาคำย่อย: ตัวพิมพ์เล็ก, แปลงเลข/สัญลักษณ์ที่ใช้แทนตัวอักษร, ตัดช่องว่าง/เครื่องหมาย, ยุบตัวอักษรซ้ำ
//      + ตัวอักษรที่ถูกปิดด้วย * (f*ck, sh*t) นับเป็นตัวอักษรใดก็ได้ 1 ตัว
//   2) คำปกติที่มีคำหยาบซ้อนข้างใน (โหดเหี้ยม, สัดส่วน) ลบออกก่อนเช็ก
//   3) คำสั้นที่ซ้อนกับคำปกติบ่อย (กู, มึง) ต้องตัดคำได้เป็นคำนั้นทั้งคำ · ต่อชิ้นที่เว้นวรรคทีละตัว (ม ึ ง) กลับก่อนตัดคำ

const WORDS = [
  // ไทย
  "ควย", "เหี้ย", "เหี่ย", "สัส", "สัด", "แม่ง", "มึง", "กู", "เย็ด", "หี", "ระยำ", "ชาติหมา", "อีดอก", "อีตัว",
  "ไอ้สัตว์", "ไอสัตว์", "ส้นตีน", "พ่อมึง", "แม่มึง", "จัญไร", "อัปรีย์", "ตอแหล", "ร่าน", "กะหรี่",
  // อังกฤษ
  "fuck", "shit", "bitch", "asshole", "cunt", "dick", "pussy", "motherfucker", "bastard",
];
// คำที่สั้นมาก/ซ้อนกับคำปกติ ต้องเจอแบบคำโดด ๆ เท่านั้น (เช่น "กู" อยู่ใน "กูเกิล", "หี" อยู่ใน "หีบ")
const LOOSE = new Set(["กู", "มึง", "หี", "สัด", "dick"]);
// คำปกติที่มีคำหยาบซ้อนอยู่ข้างใน → ลบออกก่อนเช็ก
const SAFE_PHRASES = ["โหดเหี้ยม", "เหี้ยมโหด", "เหี้ยมเกรียม", "สัดส่วน", "แม่งาน", "กูเกิ้ล", "กูเกิล", "หีบ"];
const stripSafe = s => SAFE_PHRASES.reduce((t, p) => t.replaceAll(p, " "), s);

const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i" };
const SEP = /[\s._\-*~^'"`|/\\,+()[\]{}<>]+/g;          // ตัวคั่นที่คนแทรกเพื่อเลี่ยง (ลบทิ้ง)
const SEP_KEEP_MASK = /[\s._\-~^'"`|/\\,+()[\]{}<>]+/g;  // เหมือนกันแต่เก็บ * ไว้ดูว่าปิดตัวไหน

// แปลง leet ก่อนลบเครื่องหมาย ($ ! เป็นทั้งเครื่องหมายและตัวอักษรแทน) · ยุบตัวซ้ำ 3 ตัวขึ้นไป (เหี้ยยยย → เหี้ย) แต่ไม่ยุบ ***
function normalize(s, keepMask = false) {
  return String(s || "").toLowerCase()
    .replace(/[013457@$!]/g, c => LEET[c])
    .replace(keepMask ? SEP_KEEP_MASK : SEP, "")
    .replace(/([^*])\1{2,}/gu, "$1");
}

// คำที่ปิดบางตัวด้วย *: แต่ละตัว (ยกเว้นตัวแรก) เป็นตัวจริงหรือ * ก็ได้
// ต้องเห็นตัวแรกและตัวจริงรวมอย่างน้อย 2 ตัว ไม่งั้น "****" จะตรงกับทุกคำยาว 4 ตัว · ไม่ใช้กับคำสั้นใน LOOSE (ก* ตรงกับอะไรก็ได้)
const MASKED = WORDS.filter(w => !LOOSE.has(w)).map(w => new RegExp([...w].map((c, i) => i ? `(?:${c}|\\*)` : c).join(""), "gu"));
const hasMasked = n => n.includes("*") && MASKED.some(re => [...n.matchAll(re)].some(m => [...m[0]].filter(c => c !== "*").length >= 2));

// คำโดด: ตัดเป็นคำด้วย Intl.Segmenter (ภาษาไทยไม่มีช่องว่าง)
const seg = new Intl.Segmenter("th", { granularity: "word" });
const tokens = s => [...seg.segment(String(s || "").toLowerCase())].filter(x => x.isWordLike).map(x => x.segment);
// "ม ึ ง", "ก.ู": ชิ้นยาวไม่เกิน 2 ตัวอักษรที่คั่นติดกัน = เว้นวรรคทีละตัวเพื่อเลี่ยง → ต่อกลับเป็นคำเดียว
// ข้อความปกติแทบไม่มีชิ้นสั้นขนาดนี้เรียงกันหลายชิ้น และถ้ามี การต่อกันก็ไม่ทำให้เกิดคำหยาบใหม่ (ตัดคำแล้วได้คำเดิม)
const PIECE = "[^\\s._\\-*]{1,2}", GAP = "[\\s._\\-*]+";
const SPACED = new RegExp(`(?<![^\\s._\\-*])${PIECE}(?:${GAP}${PIECE})+(?![^\\s._\\-*])`, "gu");
const joinSpaced = s => s.replace(SPACED, m => m.replace(new RegExp(GAP, "gu"), ""));

function hasBlocked(text) {
  const t = stripSafe(String(text || "").toLowerCase());
  const n = stripSafe(normalize(t));
  const toks = new Set([...tokens(t), ...tokens(stripSafe(joinSpaced(t)))]);
  return WORDS.some(w => LOOSE.has(w) ? toks.has(w) : n.includes(w)) || hasMasked(stripSafe(normalize(t, true)));
}

// เบอร์โทรไทย (มือถือ 0x-xxxx-xxxx / บ้าน 02-xxx-xxxx) — ไม่ให้ใส่เบอร์ใครในรีวิว
const PHONE = /(?:\+?66|0)[\s-]?\d(?:[\s-]?\d){7,8}/;
const hasPhone = text => PHONE.test(String(text || ""));

module.exports = { hasBlocked, hasPhone, normalize };
