// กรองคำหยาบ + ข้อมูลส่วนบุคคลแบบเบื้องต้น (ไม่ได้กันได้ทุกแบบ — ที่หลุดไปใช้ report + moderator)
// เช็กหลัง normalize: ตัวพิมพ์เล็ก, ตัดช่องว่าง/เครื่องหมาย, ยุบตัวอักษรซ้ำ, แปลงเลข/สัญลักษณ์ที่ใช้แทนตัวอักษร

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

function normalize(s) {
  return String(s || "").toLowerCase()
    .replace(/[013457@$!]/g, c => LEET[c])
    .replace(/[\s._\-*~^'"`|/\\,+()[\]{}<>]+/g, "")
    .replace(/(.)\1{2,}/gu, "$1");
}

// คำโดด: ตัดเป็นคำด้วย Intl.Segmenter (ภาษาไทยไม่มีช่องว่าง)
const seg = new Intl.Segmenter("th", { granularity: "word" });
const tokens = s => [...seg.segment(String(s || "").toLowerCase())].filter(x => x.isWordLike).map(x => x.segment);

function hasBlocked(text) {
  const t = stripSafe(String(text || "").toLowerCase());
  const n = stripSafe(normalize(t));
  const toks = new Set(tokens(t));
  return WORDS.some(w => LOOSE.has(w) ? toks.has(w) : n.includes(w));
}

// เบอร์โทรไทย (มือถือ 0x-xxxx-xxxx / บ้าน 02-xxx-xxxx) — ไม่ให้ใส่เบอร์ใครในรีวิว
const PHONE = /(?:\+?66|0)[\s-]?\d(?:[\s-]?\d){7,8}/;
const hasPhone = text => PHONE.test(String(text || ""));

module.exports = { hasBlocked, hasPhone, normalize };
