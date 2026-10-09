// ตั้งเมนูปุ่มใต้แชต LINE (rich menu) — รันบน server ครั้งเดียวหลังตั้งค่า LINE:
//   set -a; . /etc/bus-api.env; set +a; node /opt/bus-api/line-richmenu.js https://<โดเมน>
// สร้างใหม่ทุกครั้ง: ลบเมนูเก่าชื่อเดียวกันก่อน · รูป richmenu.png ขนาด 2500x843 (4 ช่องเท่ากัน)
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ORIGIN = process.argv[2] || process.env.PUBLIC_URL;
const NAME = "kan-nee-dee-mai";
if (!TOKEN || !ORIGIN) { console.error("ต้องมี LINE_CHANNEL_ACCESS_TOKEN และโดเมนเว็บ (argument แรก หรือ PUBLIC_URL)"); process.exit(1); }

async function line(method, url, body, type = "application/json") {
  const r = await fetch(url, { method, headers: { Authorization: "Bearer " + TOKEN, ...(body ? { "Content-Type": type } : {}) },
    body: body && type === "application/json" ? JSON.stringify(body) : body });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const area = (i, action) => ({ bounds: { x: i * 625, y: 0, width: 625, height: 843 }, action });

(async () => {
  for (const m of (await line("GET", "https://api.line.me/v2/bot/richmenu/list")).richmenus)
    if (m.name === NAME) { await line("DELETE", `https://api.line.me/v2/bot/richmenu/${m.richMenuId}`); console.log("ลบเมนูเก่า", m.richMenuId); }
  const { richMenuId } = await line("POST", "https://api.line.me/v2/bot/richmenu", {
    size: { width: 2500, height: 843 }, selected: true, name: NAME, chatBarText: "เมนู",
    areas: [
      area(0, { type: "postback", label: "ค้นเลขรถ", data: "a=help_bus", displayText: "ค้นเลขรถ", inputOption: "openKeyboard" }),
      area(1, { type: "uri", label: "ป้ายใกล้ฉัน", uri: "https://line.me/R/nv/location/" }),
      area(2, { type: "postback", label: "แต้มของฉัน", data: "a=points", displayText: "แต้มของฉัน" }),
      area(3, { type: "uri", label: "เปิดเว็บ", uri: ORIGIN }),
    ],
  });
  await line("POST", `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, fs.readFileSync(path.join(__dirname, "richmenu.png")), "image/png");
  await line("POST", `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`);
  console.log("ตั้งเมนูแล้ว", richMenuId);
})().catch(e => { console.error(e.message); process.exit(1); });
