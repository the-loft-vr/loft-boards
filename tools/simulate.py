"""Replay the exact URL sequences the world sends (packets.json, made by the world's own packer from the baked table)
against the live Worker, one request at a time like VRChat (spacing in seconds as argv[2], default 5.5)."""
import json, sys, time, urllib.request
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
cases = json.load(open(sys.argv[1], encoding="utf-8"))
gap = float(sys.argv[2]) if len(sys.argv) > 2 else 5.5
only = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else None
def get(u):
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "UnityPlayer/2022.3.22f1"}), timeout=30) as r: return r.read().decode()
    except urllib.error.HTTPError as e: return "HTTP %d" % e.code
for c in cases:
    if only and c["id"] not in only: continue
    answers = []
    for i, u in enumerate(c["urls"]):
        a = get(u); answers.append(a)
        expect = "0" if i == 0 else (str(i) if i < len(c["urls"]) - 1 else None)
        if expect is not None and a != expect:
            print(f"{c['id']}: request {i} answered {a!r}, expected {expect!r} -> abort"); break
        time.sleep(gap)
    print(f"{c['id']}: {len(answers)} requests, end answer {answers[-1]!r}")
