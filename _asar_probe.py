# -*- coding: utf-8 -*-
# 只读解析 app.asar 头，提取关键文件并查找 profile/插件管理逻辑
import json
import struct
import sys
import os

ASAR = r"D:\deepseek\resources\app.asar"
OUT = r"C:\Users\28726\Documents\deepseek-harness\default-workspace\out\_asar2"
os.makedirs(OUT, exist_ok=True)

data = open(ASAR, "rb").read()
print("asar bytes:", len(data))

# 尝试不同的 header 解释，找到能 JSON 解析的偏移
header = None
data_start = None
sz = struct.unpack_from("<I", data, 4)[0]
print("size field:", sz)
for start, length in ((12, sz - 4), (8, sz), (12, sz), (8, sz - 4)):
    try:
        header = json.loads(data[start:start + length].decode("utf-8"))
        data_start = start + length
        print("header ok at", start, "length", length, "data_start", data_start)
        break
    except Exception as exc:
        print("try", start, length, "->", type(exc).__name__, str(exc)[:80])
if header is None:
    sys.exit("cannot parse header")

files = {}
def walk(node, prefix):
    for name, child in (node.get("files") or {}).items():
        p = prefix + "/" + name if prefix else name
        if "files" in child:
            walk(child, p)
        else:
            files[p] = (data_start + int(child.get("offset", 0)), int(child.get("size", 0)))
walk(header, "")
print("files:", len(files))

# 打印顶层结构与候选文件
print("top-level:", list((header.get("files") or {}).keys())[:20])
candidates = [p for p in files if ("main" in p or "profile" in p or "plugin" in p or "desktop" in p)]
print("candidates:", len(candidates))
for p in candidates[:40]:
    off, size = files[p]
    print(" ", p, size)

# 提取小体积候选 JS 到临时目录
needles = [b"managed exclusively by the Electron application", b"dsh.profile.bundles", b"profile.bundles", b"plugin --profile"]
found = []
for p in candidates:
    off, size = files[p]
    if size <= 0 or size > 4 * 1024 * 1024 or not p.endswith((".js", ".mjs", ".cjs", ".json")):
        continue
    chunk = data[off:off + size]
    for needle in needles:
        idx = chunk.find(needle)
        if idx >= 0:
            found.append((p, needle.decode(), idx, size))
            break
    if p in ("lib/main.js",):
        open(os.path.join(OUT, "main.js"), "wb").write(chunk)
        print("extracted lib/main.js", size)

print("hits:", len(found))
for p, needle, idx, size in found[:15]:
    off, _ = files[p]
    chunk = data[off:off + size]
    ctx = chunk[max(0, idx - 400): idx + 800].decode("utf-8", "replace").replace("\r", "")
    print("\n=====", needle, "->", p, "size", size)
    print(ctx[:1200])
