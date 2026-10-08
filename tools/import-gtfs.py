#!/usr/bin/env python3
"""ดึงสายรถเมล์ + ป้ายในกรุงเทพจาก GTFS ของ สนข. (Namtang) → api/routes.json

ที่มา: https://namtang-api.otp.go.th/download/namtang-gtfs.zip
       สำนักงานนโยบายและแผนการขนส่งและจราจร (สนข.) — CC BY 4.0 (ดูเครดิตใน privacy.html)
เก็บเฉพาะรถเมล์ (route_type 3) ของ ขสมก. / ไทย สมายล์ บัส / กทม. / รถร่วมในกรุงเทพ
แต่ละสายเก็บป้ายตามลำดับ ทิศละ 1 เที่ยว (เที่ยวที่ผ่านป้ายมากที่สุด) · ไม่เก็บ shapes/ค่าโดยสาร
รันใหม่เมื่ออยากได้ข้อมูลล่าสุด: python3 tools/import-gtfs.py [ไฟล์ zip ที่โหลดไว้แล้ว]
"""
import csv, io, json, os, re, sys, tempfile, urllib.request, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "https://namtang-api.otp.go.th/download/namtang-gtfs.zip"
AGENCIES = {"BMTA": "ขสมก.", "TSB": "ไทย สมายล์ บัส", "BMA": "กทม.", "BUS524": "ไทย สมายล์ บัส"}

def th(s): return (s or "").split(";")[0].strip()

if len(sys.argv) > 1: path = sys.argv[1]
else:
    path = os.path.join(tempfile.mkdtemp(), "namtang-gtfs.zip")
    urllib.request.urlretrieve(URL, path)
z = zipfile.ZipFile(path)
def rows(n): return csv.DictReader(io.TextIOWrapper(z.open(n), encoding="utf-8-sig"))

feed = next(rows("feed_info.txt"))
routes = {r["route_id"]: r for r in rows("routes.txt") if r["route_type"] == "3" and r["agency_id"] in AGENCIES}
trips = {t["trip_id"]: t for t in rows("trips.txt") if t["route_id"] in routes}
seqs = {}
for st in rows("stop_times.txt"):
    if st["trip_id"] in trips: seqs.setdefault(st["trip_id"], []).append((int(st["stop_sequence"]), st["stop_id"]))

# ทิศละ 1 เที่ยว: เที่ยวที่ผ่านป้ายมากที่สุด
best = {}
for tid, s in seqs.items():
    t = trips[tid]; k = (t["route_id"], t["direction_id"] or "0")
    if k not in best or len(s) > len(seqs[best[k]]): best[k] = tid

out, used = [], set()
for rid, r in routes.items():
    dirs = []
    for d in ("0", "1"):
        tid = best.get((rid, d))
        if not tid: continue
        stops = [sid for _, sid in sorted(seqs[tid])]
        stops = [s for i, s in enumerate(stops) if i == 0 or s != stops[i - 1]]
        if len(stops) < 2: continue
        dirs.append({"head": th(trips[tid]["trip_headsign"]), "stops": stops}); used.update(stops)
    if not dirs: continue
    short = re.sub(r"\s+", " ", r["route_short_name"]).strip()
    m = re.match(r"^([1-4]-\d+[A-Z]?)\s*(?:\((.+)\))?$", short)
    kind = re.sub(r"^รถโดยสาร(ประจำทาง)?\s*", "", th(r["route_desc"]))
    out.append({"id": rid, "no": m.group(1) if m else short, "old": (m.group(2) or "") if m else "",
                "name": th(r["route_long_name"]), "agency": AGENCIES[r["agency_id"]], "kind": kind, "dirs": dirs})

stops = {s["stop_id"]: [th(s["stop_name"]), round(float(s["stop_lat"]), 5), round(float(s["stop_lon"]), 5)]
         for s in rows("stops.txt") if s["stop_id"] in used}
out.sort(key=lambda r: (r["old"] or r["no"], r["no"], r["id"]))
data = {"source": URL, "version": feed["feed_version"], "license": "CC BY 4.0", "routes": out, "stops": stops}
with open(os.path.join(ROOT, "api", "routes.json"), "w") as f:
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
print(f"{len(out)} สาย · {len(stops)} ป้าย · feed {feed['feed_version']}")
