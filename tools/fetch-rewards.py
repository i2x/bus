#!/usr/bin/env python3
"""ดึงรูปสติกเกอร์/รูปโปรไฟล์ตาม api/rewards.json → stickers/*.webp, avatars/*.(webp|svg)

ที่มา (ใช้ได้ตามสัญญาอนุญาต — ดูเครดิตใน privacy.html):
  fluent:<path>             Microsoft Fluent Emoji 3D (MIT) — github.com/microsoft/fluentui-emoji
  dicebear:<style>:<seed>   DiceBear 9.x (notionists/lorelei/thumbs = CC0, fun-emoji = CC BY 4.0)
ต้องมี cwebp (brew install webp) · รันซ้ำได้ ไฟล์ที่มีแล้วข้าม (ใส่ --force เพื่อโหลดใหม่)
"""
import json, os, subprocess, sys, tempfile, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FLUENT = "https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/"
DICEBEAR = "https://api.dicebear.com/9.x/{style}/svg?seed={rest}"
LICENSES = {"notionists": "publicdomain/zero", "lorelei": "publicdomain/zero", "thumbs": "publicdomain/zero", "fun-emoji": "licenses/by/4.0"}
force = "--force" in sys.argv

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "bus-fetch-rewards"}), timeout=30) as r:
        return r.read()

for x in json.load(open(os.path.join(ROOT, "api", "rewards.json"))):
    src, img = x.get("source"), x.get("img")
    if not src: continue
    out = os.path.join(ROOT, img)
    if os.path.exists(out) and not force: continue
    os.makedirs(os.path.dirname(out), exist_ok=True)
    if src.startswith("fluent:"):
        png = get(FLUENT + urllib.parse.quote(src[len("fluent:"):]))
        with tempfile.NamedTemporaryFile(suffix=".png") as t:
            t.write(png); t.flush()
            subprocess.run(["cwebp", "-quiet", "-q", "82", "-alpha_q", "90", "-resize", "128", "128", t.name, "-o", out], check=True)
    else:
        _, style, rest = src.split(":", 2)
        svg = get(DICEBEAR.format(style=style, rest=rest)).decode()
        if LICENSES[style] not in svg: sys.exit(f"license of {style} changed — check before using: {x['id']}")
        open(out, "w").write(svg)
    print("ok", x["id"], os.path.getsize(out), "bytes")
