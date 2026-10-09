// แชตบอท LINE — ตอบเฉพาะสิ่งที่ค้นจากรหัสหรือพิกัดได้แน่นอน: เลขข้างรถ · เลขสาย · ตำแหน่ง → ป้ายใกล้ · แต้ม
// ตอบด้วย reply ทั้งหมด (ไม่กินโควตาข้อความของแผนฟรี) · รีวิว/แจ้งเหตุ/ติดตาม ต้องเชื่อมบัญชีเว็บก่อน
const SESSION_MIN = 10;   // ขั้นตอนรีวิว/เล่าเหตุ ค้างได้นานเท่านี้
const STAR_STEPS = [["stars_driving", "การขับ"], ["stars_stops", "การจอดป้าย"], ["stars_condition", "สภาพรถ"]];
const INCIDENTS = { breakdown: "รถเสีย", accident: "อุบัติเหตุ" };
const REASONS = { signup: "สมัครสมาชิก", review: "เขียนรีวิว", review_detail: "ใส่ป้ายและเวลา", helpful_received: "มีคนกดมีประโยชน์",
  incident_confirmed: "แจ้งเหตุมีคนยืนยันครบ", report_upheld: "รีวิวผิดกติกา", route_tag: "บอกสาย", redeem: "แลกของ", jury_majority: "โหวตตรงเสียงส่วนใหญ่ (ลูกขุน)" };
const GTFS_NOTE = "ข้อมูลสายและป้าย: GTFS ของ สนข. อาจไม่ตรงกับเส้นทางจริงทุกสาย";

module.exports = function lineBot({ pool, linePost, parseFleet, DATA, busRoutes, createReview, addFollow, juryVote }) {
  const reply = (token, messages) => linePost("/v2/bot/message/reply", { replyToken: token, messages: [].concat(messages).slice(0, 5) });
  const text = (t, quick) => ({ type: "text", text: t.slice(0, 4900), ...(quick ? { quickReply: { items: quick.slice(0, 13) } } : {}) });
  const qPost = (label, data, shown = label) => ({ type: "action", action: { type: "postback", label, data, displayText: shown } });
  const qMsg = (label, t = label) => ({ type: "action", action: { type: "message", label, text: t } });
  const qLoc = () => ({ type: "action", action: { type: "location", label: "📍 ส่งตำแหน่ง" } });
  const HELP_QUICK = [qMsg("ตัวอย่าง 7-3077", "7-3077"), qMsg("ตัวอย่าง สาย 8", "สาย 8"), qLoc(), qMsg("แต้มของฉัน", "แต้ม")];
  const HELP = "พิมพ์ได้ 3 แบบ:\n• เลขข้างรถ เช่น 7-3077 → รุ่น คะแนน รีวิว\n• เลขสาย เช่น สาย 8 → ปลายทาง และคันที่วิ่งสายนี้\n• กด 📍 ส่งตำแหน่ง → ป้ายใกล้คุณ และสายที่ผ่าน\nพิมพ์ \"แต้ม\" เพื่อดูแต้มของคุณ";

  // ---------- flex ----------
  const t = (s, o = {}) => ({ type: "text", text: String(s), wrap: true, size: "sm", ...o });
  const row = (k, v) => ({ type: "box", layout: "baseline", spacing: "sm", contents: [t(k, { color: "#8a857c", flex: 2 }), t(v, { flex: 5 })] });
  const btn = (label, action, style = "secondary") => ({ type: "button", style, height: "sm", action: { ...action, label } });
  const pb = data => ({ type: "postback", data });
  const uri = u => ({ type: "uri", uri: u });
  const stars = v => v == null ? "–" : `${"★".repeat(Math.round(v))}${"☆".repeat(5 - Math.round(v))} ${v.toFixed(1)}`;

  function fareText(model) {
    const f = model && DATA.LIVERY[model.livery] && DATA.LIVERY[model.livery].fare;
    if (!f) return "ไม่มีข้อมูล";
    if (f.type === "flat") return `${f.standard} บาท`;
    return `${Math.min(...f.km)}–${Math.max(...f.km)} บาท ตามระยะทาง`;
  }

  async function busCard(f, origin) {
    const [st, rv, routes] = await Promise.all([
      pool.query(`SELECT count(*) FILTER (WHERE type = 'review')::int AS n, round(avg(stars_driving), 1)::float AS d, round(avg(stars_stops), 1)::float AS s,
          round(avg(stars_condition), 1)::float AS c, round(avg((stars_driving + stars_stops + stars_condition) / 3.0), 1)::float AS avg
        FROM reviews WHERE fleet_no = $1 AND status = 'visible'`, [f.fleet_no]),
      pool.query(`SELECT type, text, created_at FROM reviews WHERE fleet_no = $1 AND status = 'visible' ORDER BY created_at DESC LIMIT 2`, [f.fleet_no]),
      busRoutes(pool, f.fleet_no),
    ]);
    const s = st.rows[0], model = DATA.MODELS.find(m => m.id === f.model_id), zone = DATA.ZONES[f.zone];
    const body = [
      t(f.fleet_no, { size: "xxl", weight: "bold" }),
      t(model ? `${model.brand} ${model.model} · ${DATA.LIVERY[model.livery] ? DATA.LIVERY[model.livery].name : ""}` : "ไม่พบรุ่นของเลขนี้ในข้อมูล", { color: "#6b6760" }),
      { type: "separator", margin: "md" },
      { type: "box", layout: "vertical", margin: "md", spacing: "xs", contents: [
        row("เขต", zone ? `เขต ${f.zone} (${zone.office})` : `เขต ${f.zone}`),
        ...(model ? [row("ปีที่เริ่ม", String(model.year)), row("ค่าโดยสาร", fareText(model))] : []),
        row("วิ่งสาย", routes.length ? routes.map(r => `${r.label} (${r.n} คน)`).join(", ") : "ยังไม่มีคนบอก"),
      ] },
      { type: "separator", margin: "md" },
      s.n ? { type: "box", layout: "vertical", margin: "md", spacing: "xs", contents: [
        t(`คะแนน ${s.avg.toFixed(1)} จาก ${s.n} รีวิว`, { weight: "bold" }),
        row("การขับ", stars(s.d)), row("จอดป้าย", stars(s.s)), row("สภาพรถ", stars(s.c)),
      ] } : t("ยังไม่มีรีวิว — เป็นคนแรกได้เลย", { margin: "md", color: "#6b6760" }),
      ...rv.rows.map(r => t(`${r.type === "incident" ? "🚨" : "💬"} "${r.text.length > 80 ? r.text.slice(0, 80) + "…" : r.text}"`, { margin: "sm", color: "#3d3a35" })),
    ];
    const enc = encodeURIComponent(f.fleet_no);
    return { type: "flex", altText: `รถ ${f.fleet_no}${s.n ? ` คะแนน ${s.avg.toFixed(1)}` : ""}`, contents: { type: "bubble",
      body: { type: "box", layout: "vertical", contents: body },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
        btn("⭐ รีวิวคันนี้", pb(`a=rate&bus=${enc}`), "primary"),
        { type: "box", layout: "horizontal", spacing: "sm", contents: [btn("🚨 แจ้งเหตุ", pb(`a=inc&bus=${enc}`)), btn("🔔 ติดตาม", pb(`a=follow&kind=bus&t=${enc}`))] },
        btn("เปิดในเว็บ", uri(`${origin}/#${f.fleet_no}`), "link"),
      ] } } };
  }

  async function routeCards(q, origin) {
    const r = await pool.query(`SELECT id, no, old_no, name, agency, kind FROM gtfs_routes
      WHERE lower(old_no) = lower($1) OR lower(no) = lower($1) ORDER BY old_no = '', no, id LIMIT 10`, [q]);
    if (!r.rowCount) return null;
    const bubbles = await Promise.all(r.rows.map(async x => {
      const label = x.old_no || x.no;
      const buses = await pool.query(`SELECT fleet_no, count(DISTINCT user_id)::int AS n FROM (
          SELECT fleet_no, user_id FROM bus_route_sightings WHERE route_id = $1 AND created_at > now() - interval '60 days'
          UNION ALL SELECT fleet_no, user_id FROM reviews WHERE route_id = $1 AND status = 'visible' AND created_at > now() - interval '60 days') s
        GROUP BY 1 ORDER BY n DESC LIMIT 5`, [x.id]);
      return { type: "bubble", size: "kilo",
        body: { type: "box", layout: "vertical", spacing: "sm", contents: [
          t(`สาย ${label}`, { size: "xl", weight: "bold" }),
          t(x.name, { weight: "bold" }),
          t(`${x.agency || "-"}${x.kind ? " · " + x.kind : ""}${x.old_no && x.no !== x.old_no ? ` · เลขใหม่ ${x.no}` : ""}`, { color: "#6b6760", size: "xs" }),
          { type: "separator", margin: "md" },
          t(buses.rowCount ? "คันที่ผู้โดยสารบอกว่าวิ่งสายนี้" : "ยังไม่มีใครบอกว่าคันไหนวิ่งสายนี้", { color: "#6b6760", size: "xs", margin: "md" }),
          ...buses.rows.map(b => ({ type: "button", height: "sm", style: "link", action: { type: "message", label: `${b.fleet_no} (${b.n} คน)`, text: b.fleet_no } })),
        ] },
        footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
          btn("🔔 ติดตามสายนี้", pb(`a=follow&kind=route&t=${encodeURIComponent(x.id)}`)),
          btn("ดูป้ายในเว็บ", uri(`${origin}/?tab=routes`), "link"),
        ] } };
    }));
    return [{ type: "flex", altText: `สาย ${q} ${r.rowCount} เส้นทาง`, contents: { type: "carousel", contents: bubbles } }, text(GTFS_NOTE)];
  }

  async function nearStops(lat, lon) {
    // ระยะแบบประมาณบนพื้นผิวเรียบ (ระยะไม่กี่กิโลเมตร คลาดเคลื่อนน้อยมาก)
    const st = await pool.query(`SELECT id, name, lat, lon, 111320 * sqrt(power(lat - $1, 2) + power((lon - $2) * cos(radians($1)), 2)) AS m
      FROM gtfs_stops ORDER BY 5 LIMIT 3`, [lat, lon]);
    const stops = st.rows.filter(x => x.m <= 1000);
    if (!stops.length) return text("ไม่มีป้ายรถเมล์ในข้อมูลภายใน 1 กม. จากตำแหน่งนี้", HELP_QUICK);
    const rr = await pool.query(`SELECT rs.stop_id, COALESCE(NULLIF(g.old_no, ''), g.no) AS label FROM gtfs_route_stops rs JOIN gtfs_routes g ON g.id = rs.route_id
      WHERE rs.stop_id = ANY($1) ORDER BY 2`, [stops.map(x => x.id)]);
    const per = new Map(stops.map(x => [x.id, new Set()]));
    for (const x of rr.rows) per.get(x.stop_id).add(x.label);
    return { type: "flex", altText: `ป้ายใกล้คุณ: ${stops.map(x => x.name).join(", ")}`, contents: { type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents: [
        t("ป้ายใกล้คุณ", { size: "lg", weight: "bold" }),
        ...stops.map(x => ({ type: "box", layout: "vertical", spacing: "xs", contents: [
          t(`${x.name}  ·  ${Math.round(x.m / 10) * 10} ม.`, { weight: "bold" }),
          t(per.get(x.id).size ? `สาย ${[...per.get(x.id)].join(", ")}` : "ไม่มีสายในข้อมูล", { color: "#3d3a35" }),
          { type: "button", style: "link", height: "sm", action: { type: "uri", label: "เปิดแผนที่", uri: `https://www.google.com/maps/search/?api=1&query=${x.lat},${x.lon}` } },
        ] })),
        t(GTFS_NOTE, { size: "xxs", color: "#8a857c" }),
      ] } } };
  }

  // ---------- บัญชี + ขั้นตอนค้าง ----------
  const userOf = async uid => (await pool.query("SELECT id, display_name FROM users WHERE line_user_id = $1", [uid])).rows[0] || null;
  const needLink = origin => text(`ต้องเชื่อมบัญชีเว็บก่อนครับ\nในเว็บไปที่แท็บ "ฉัน" กด "เชื่อม LINE" แล้วส่งรหัส 6 ตัวมาที่นี่\n${origin}/?tab=me`);
  const getSession = async uid => (await pool.query("SELECT state FROM line_sessions WHERE line_user_id = $1 AND expires_at > now()", [uid])).rows[0]?.state || null;
  const setSession = (uid, state) => pool.query(`INSERT INTO line_sessions (line_user_id, state, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))
    ON CONFLICT (line_user_id) DO UPDATE SET state = EXCLUDED.state, expires_at = EXCLUDED.expires_at`, [uid, state, SESSION_MIN]);
  const endSession = uid => pool.query("DELETE FROM line_sessions WHERE line_user_id = $1", [uid]);
  const starAsk = (i, bus) => text(`${bus} · ${i + 1}/3 — ${STAR_STEPS[i][1]}เป็นยังไง?`,
    [5, 4, 3, 2, 1].map(v => qPost(`${"⭐".repeat(v)}`, `a=star&v=${v}`, `${STAR_STEPS[i][1]} ${v} ดาว`)).concat(qPost("ยกเลิก", "a=cancel")));
  const errText = e => e.status ? e.message : "ระบบขัดข้อง ลองใหม่อีกครั้ง";

  async function save(uid, user, s, extra, origin) {
    try {
      const out = await createReview(user.id, { fleet_no: s.bus, ...extra }, origin);
      await endSession(uid);
      return text(extra.type === "incident"
        ? `แจ้งเหตุรถ ${s.bus} แล้ว ✅\nคนที่ติดตามรถคันนี้จะได้ข้อความทาง LINE`
        : `บันทึกรีวิวรถ ${s.bus} แล้ว ✅ +${out.earned} แต้ม`, [qMsg(`ดูรถ ${s.bus}`, s.bus), qMsg("แต้มของฉัน", "แต้ม")]);
    } catch (e) {
      if (e.status === 400) return text(`${errText(e)}\nพิมพ์ใหม่ได้เลย`, [qPost("ยกเลิก", "a=cancel")]);   // คำไม่เหมาะสม → พิมพ์ใหม่ในขั้นเดิม
      await endSession(uid);
      return text(errText(e));
    }
  }

  async function onPostback(uid, data, origin) {
    const p = new URLSearchParams(data), a = p.get("a");
    if (a === "help_bus") return text("พิมพ์เลขข้างรถ เช่น 7-3077 (เลขเขต-หมายเลข ที่ข้างรถหรือท้ายรถ)", [qMsg("ตัวอย่าง 7-3077", "7-3077")]);
    if (a === "points") return points(uid, origin);
    if (a === "cancel") { await endSession(uid); return text("ยกเลิกแล้ว", HELP_QUICK); }
    const user = await userOf(uid);
    if (!user) return needLink(origin);
    if (a === "jury") {
      let r;
      try { r = await juryVote(user.id, parseInt(p.get("c"), 10), p.get("v"), origin); }
      catch (e) { return text(errText(e)); }
      const c = r.closed;
      if (!c) return text("บันทึกเสียงแล้ว ⚖️ ผลจะประกาศเมื่อปิดคดี");
      return text(c.by === "god" ? `บันทึกแล้ว ลูกขุนโหวตไม่ขาด พระเจ้าโยนเหรียญ… ออก ${c.outcome === "hide" ? "🔥 เผา" : "🕊️ ปล่อย"} ⚔️ DEUS VULT`
        : `บันทึกแล้ว คดีปิด: ${c.outcome === "hide" ? "🔥 เผา" : "🕊️ ปล่อย"} ${c.hide}–${c.keep}`);
    }
    if (a === "follow") {
      try { await addFollow(user.id, p.get("kind"), p.get("t")); }
      catch (e) { return text(errText(e)); }
      return text(`ติดตามแล้ว 🔔 มีคนแจ้งเหตุ${p.get("kind") === "bus" ? `รถ ${p.get("t")}` : "ในสายนี้"}เมื่อไหร่จะส่งมาที่นี่\nเลิกติดตามได้ที่แท็บ "ฉัน" ในเว็บ`);
    }
    if (a === "rate" || a === "inc") {
      const f = parseFleet(p.get("bus"));
      if (!f) return text("เลขข้างรถไม่ถูกต้อง");
      if (a === "inc") return text(`รถ ${f.fleet_no} เกิดอะไรขึ้น?`, [
        ...Object.entries(INCIDENTS).map(([k, v]) => qPost(v, `a=inc_kind&bus=${encodeURIComponent(f.fleet_no)}&k=${k}`)),
        qPost("อื่น ๆ (พิมพ์เล่า)", `a=inc_kind&bus=${encodeURIComponent(f.fleet_no)}&k=other`), qPost("ยกเลิก", "a=cancel")]);
      const done = await pool.query(`SELECT 1 FROM reviews WHERE user_id = $1 AND fleet_no = $2 AND type = 'review'
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok'`, [user.id, f.fleet_no]);
      if (done.rowCount) return text("วันนี้รีวิวคันนี้ไปแล้ว — พรุ่งนี้มาใหม่นะ");
      await setSession(uid, { step: "stars", bus: f.fleet_no, s: [] });
      return starAsk(0, f.fleet_no);
    }
    if (a === "inc_kind") {
      const f = parseFleet(p.get("bus")), k = p.get("k");
      if (!f) return text("เลขข้างรถไม่ถูกต้อง");
      if (INCIDENTS[k]) return save(uid, user, { bus: f.fleet_no }, { type: "incident", text: INCIDENTS[k] }, origin);
      await setSession(uid, { step: "inc_text", bus: f.fleet_no });
      return text(`เล่าเหตุการณ์รถ ${f.fleet_no} สั้น ๆ (ห้ามระบุชื่อหรือเบอร์โทร)`, [qPost("ยกเลิก", "a=cancel")]);
    }
    if (a === "star") {
      const s = await getSession(uid), v = parseInt(p.get("v"), 10);
      if (!s || s.step !== "stars" || !(v >= 1 && v <= 5)) return text("หมดเวลาแล้ว — กด \"รีวิวคันนี้\" ใหม่อีกครั้ง");
      s.s.push(v);
      if (s.s.length < 3) { await setSession(uid, s); return starAsk(s.s.length, s.bus); }
      await setSession(uid, { ...s, step: "rate_text" });
      return text(`พิมพ์รีวิวรถ ${s.bus} สั้น ๆ 1 ประโยค เช่น "แอร์เย็น ขับนิ่ม"\nรีวิวรถ ไม่ใช่ตัวบุคคล · ห้ามใส่เบอร์โทร`, [qPost("ยกเลิก", "a=cancel")]);
    }
    return text(HELP, HELP_QUICK);
  }

  async function points(uid, origin) {
    const user = await userOf(uid);
    if (!user) return needLink(origin);
    const [bal, led] = await Promise.all([
      pool.query("SELECT COALESCE(SUM(delta), 0)::int AS p FROM points_ledger WHERE user_id = $1", [user.id]),
      pool.query("SELECT delta, reason, note FROM points_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 5", [user.id]),
    ]);
    const lines = led.rows.map(x => `${x.delta > 0 ? "+" : ""}${x.delta}  ${REASONS[x.reason] || x.reason}${x.note ? ` (${x.note})` : ""}`);
    return text(`${user.display_name} มี ${bal.rows[0].p} แต้ม\n\nล่าสุด\n${lines.join("\n") || "-"}\n\nแลกของ: ${origin}/?tab=shop`);
  }

  async function onText(uid, raw, origin) {
    const msg = raw.trim();
    const s = await getSession(uid);
    if (s && (s.step === "rate_text" || s.step === "inc_text")) {
      const user = await userOf(uid);
      if (!user) { await endSession(uid); return needLink(origin); }
      return s.step === "inc_text"
        ? save(uid, user, s, { type: "incident", text: msg }, origin)
        : save(uid, user, s, { type: "review", text: msg, stars_driving: s.s[0], stars_stops: s.s[1], stars_condition: s.s[2] }, origin);
    }
    if (/^(แต้ม|คะแนนของฉัน|points?)$/i.test(msg)) return points(uid, origin);
    // เลขข้างรถ: 7-3077 / 7 3077 / 7–3077
    const fm = msg.match(/^([1-8])\s*[-–—\s]\s*(\d{4,5})$/);
    if (fm) { const f = parseFleet(`${fm[1]}-${fm[2]}`); if (f) return busCard(f, origin); }
    // ไม่มีเลขเขต → ให้เลือกเขตที่รุ่นรถตรงกับหมายเลข (ไม่เดาให้)
    if (/^\d{4,5}$/.test(msg)) {
      const zones = new Set(DATA.MODELS.filter(m => msg.length === m.digits && msg.startsWith(m.prefix)).flatMap(m => Object.keys(m.zones)));
      const list = (zones.size ? [...zones] : ["1", "2", "3", "4", "5", "6", "7", "8"]).sort();
      return text(`เลข ${msg} อยู่เขตไหน? (เลขเขตคือตัวเลขหน้าขีด ที่ข้างรถ)`, list.map(z => qMsg(`${z}-${msg}`)));
    }
    const rm = msg.match(/^(?:สาย\s*)?([0-9ก-ฮA-Za-z]{1,4}(?:-[0-9]{1,3}[A-Za-z]{0,2})?)$/);
    if (rm) { const cards = await routeCards(rm[1], origin); if (cards) return cards; }
    if (/^สาย/.test(msg)) return text(`ไม่พบสาย "${msg.replace(/^สาย\s*/, "")}" ในข้อมูล ลองพิมพ์เลขสายอย่างเดียว เช่น สาย 8 หรือ สาย 1-12E`, HELP_QUICK);
    return text(HELP, HELP_QUICK);
  }

  // event ที่ไม่ใช่การเชื่อมบัญชี / follow / unfollow
  return async function handle(ev, uid, origin) {
    if (ev.type === "postback") return reply(ev.replyToken, await onPostback(uid, String(ev.postback?.data || ""), origin));
    if (ev.type !== "message" || !ev.message) return;
    if (ev.message.type === "location") return reply(ev.replyToken, await nearStops(+ev.message.latitude, +ev.message.longitude));
    if (ev.message.type === "text") return reply(ev.replyToken, await onText(uid, String(ev.message.text), origin));
    return reply(ev.replyToken, text(HELP, HELP_QUICK));
  };
};
