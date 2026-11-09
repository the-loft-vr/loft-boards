// Unit tests for the Worker's pure parts (no Cloudflare needed): node --test worker/test
// The packer below mirrors the world's LoftGlobalBoard34.Pack (r39: version 1 when every record fits it, else version 2).
import test from "node:test";
import assert from "node:assert/strict";
import { parsePacket, checksum, capFor, listable, exportText } from "../src/index.js";

const KEY = 777123;
const DAY = 86400000;
const LAUNCH = Date.UTC(2026, 10, 5);

function pack(relay, name, recs, key = KEY, forceVer = 0) {
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  const nb = [...new TextEncoder().encode(name)];
  const v2 = forceVer === 2 || (forceVer === 0 && (recs.length > 15 || recs.some(([b]) => b > 10)));
  const wide = v2 ? 5 : 4;
  put(forceVer === 3 ? 3 : (v2 ? 2 : 1), 3); put(relay ? 1 : 0, 1); put(nb.length, 7);
  for (const b of nb) put(b, 8);
  put(recs.length, wide);
  for (const [b, v] of recs) { let w = 0; while (w < 30 && (v >> w) > 0) w++; put(b, wide); put(w, 5); put(v, w); }
  const syms = [];
  for (let i = 0; i < bits.length; i += 10) { let s = 0; for (let j = 0; j < 10; j++) s = s * 2 + (i + j < bits.length ? bits[i + j] : 0); syms.push(s); }
  const h = checksum(key, syms);
  return [...syms, h >> 10, h & 1023];
}

test("version 1 packets (worlds before r39) still parse", () => {
  const p = parsePacket(pack(false, "Moe The Greatt", [[3, 11405], [9, 12]]), KEY);
  assert.deepEqual(p, { relay: false, name: "Moe The Greatt", recs: [[3, 11405], [9, 12]] });
});

test("version 2 packets carry the r39 boards 11..21", () => {
  const recs = [[11, 7], [12, 123456], [13, 18], [14, 54321], [15, 47], [16, 98765], [17, 15], [18, 3600], [19, 61], [20, 600], [21, 7200]];
  const p = parsePacket(pack(true, "テスト太郎", recs), KEY);
  assert.equal(p.err, undefined);
  assert.equal(p.relay, true); assert.equal(p.name, "テスト太郎");
  assert.deepEqual(p.recs, recs);
});

test("version 2 takes all 22 boards in one packet; version 1 cannot name board 11+", () => {
  const all = Array.from({ length: 22 }, (_, b) => [b, b + 1]);
  assert.deepEqual(parsePacket(pack(false, "A", all), KEY).recs, all);
  assert.equal(parsePacket(pack(false, "A", [[0, 1]], KEY, 2), KEY).recs[0][0], 0);   // v2 for old boards is fine too
  assert.equal(parsePacket(pack(false, "A", [[22, 1]], KEY, 2), KEY).err, "record");   // no board 22
});

test("bad packets are refused", () => {
  const good = pack(false, "Ana", [[12, 500]]);
  const bad = good.slice(); bad[2] ^= 1;
  assert.equal(parsePacket(bad, KEY).err, "checksum");
  assert.equal(parsePacket(good, KEY + 1).err, "checksum");
  assert.equal(parsePacket(pack(false, "Ana", [[12, 5], [12, 6]]), KEY).err, "record");   // a board twice
  assert.equal(parsePacket(pack(false, "Ana", [[1, 5]], KEY, 3), KEY).err, "version");
});

test("sanity caps for the r39 boards (per day since the launch, never above the world's own caps)", () => {
  const d1 = LAUNCH + DAY / 2, d10 = LAUNCH + 9.5 * DAY;
  assert.equal(capFor(11, d1), 1500); assert.equal(capFor(11, d10), 15000);
  assert.equal(capFor(12, d1), 3000000); assert.equal(capFor(12, LAUNCH + 400 * DAY), 99999999);
  assert.equal(capFor(13, d1), 150); assert.equal(capFor(13, LAUNCH + 400 * DAY), 999);
  assert.equal(capFor(15, d1), 60); assert.equal(capFor(17, d1), 60);
  assert.equal(capFor(14, d1), 2000000); assert.equal(capFor(16, d1), 2000000);
  for (let b = 18; b <= 21; b++) assert.equal(capFor(b, d1), 90000);
  assert.equal(capFor(22, d1), 0);
  // old boards unchanged
  assert.equal(capFor(0, d10), 40); assert.equal(capFor(9, d10), 30); assert.equal(capFor(3, d1), 90000);
});

test("listable: minimums (Time 5 min, NES time 1 min), caps, unknown boards", () => {
  const now = LAUNCH + 3 * DAY;
  assert.equal(listable(3, 299, now), false); assert.equal(listable(3, 300, now), true);
  assert.equal(listable(18, 59, now), false); assert.equal(listable(18, 60, now), true);
  assert.equal(listable(11, 1, now), true); assert.equal(listable(12, 0, now), false);
  assert.equal(listable(13, capFor(13, now) + 1, now), false);
  assert.equal(listable(22, 5, now), false); assert.equal(listable(-1, 5, now), false);
});

// a tiny stand-in for D1: only the two SELECTs exportText makes
function fakeDb(scores, tombs = []) {
  return {
    prepare(sql) {
      let args = [];
      const st = {
        bind(...a) { args = a; return st; },
        async all() {
          if (sql.includes("FROM tomb")) return { results: tombs.slice(0, args[0]) };
          const [b, lim] = args;
          return { results: scores.filter(r => r.board === b).sort((x, y) => y.best - x.best).slice(0, lim) };
        },
      };
      return st;
    },
  };
}

function sections(text) {
  const out = {}; let cur = null;
  for (const ln of text.split("\n")) { if (ln.startsWith("#")) { cur = ln.slice(1); out[cur] = []; } else if (ln && cur !== null) out[cur].push(ln); }
  return out;
}

test("export: 22 sections, r39 boards top 10, old boards top 20, under the iPad budget", async () => {
  const scores = [];
  for (let b = 0; b < 22; b++) for (let i = 0; i < 40; i++) scores.push({ board: b, name: "Player_" + String(i).padStart(2, "0") + "_x", best: (b === 3 ? 400 : b >= 18 ? 120 : 2) + 40 - i });
  const txt = await exportText({ DB: fakeDb(scores) });
  const sec = sections(txt);
  for (let b = 0; b < 22; b++) assert.ok(String(b) in sec, "section " + b);
  const bytes = new TextEncoder().encode(txt).length;
  assert.ok(bytes <= 6500, "bytes " + bytes);
  // round robin: every board gets its first places before any board gets more
  const counts = Array.from({ length: 22 }, (_, b) => sec[b].length);
  assert.ok(counts.every(c => c >= 5), JSON.stringify(counts));
  for (let b = 11; b < 22; b++) assert.ok(counts[b] <= 10);
  console.log("    export with 22 full boards (typical 12-byte names): " + bytes + " bytes, entries per board " + counts.join(","));
});

test("export: sparse r39 boards (today's data plus a few new scores) list in full", async () => {
  const scores = [{ board: 3, name: "Moe The Greatt", best: 11405 }, { board: 12, name: "Ana", best: 52000 }, { board: 13, name: "Ana", best: 16 },
    { board: 18, name: "Bo", best: 59 }, { board: 19, name: "Bo", best: 3600 }, { board: 11, name: "Cid", best: 9 }];
  const sec = sections(await exportText({ DB: fakeDb(scores) }));
  assert.deepEqual(sec["12"], ["Ana\t52000"]); assert.deepEqual(sec["13"], ["Ana\t16"]); assert.deepEqual(sec["11"], ["Cid\t9"]);
  assert.deepEqual(sec["18"], []);                        // 59 s: under a minute, not listed
  assert.deepEqual(sec["19"], ["Bo\t3600"]);
});

test("worst case names (24 CJK letters) still fit the budget", async () => {
  const scores = [];
  for (let b = 0; b < 22; b++) for (let i = 0; i < 25; i++) scores.push({ board: b, name: "漢字漢字漢字漢字漢字漢字漢字漢字漢字漢字漢" + String(i).padStart(3, "0"), best: (b === 3 ? 400 : b >= 18 ? 120 : 2) + 30 - i });
  const txt = await exportText({ DB: fakeDb(scores) });
  assert.ok(new TextEncoder().encode(txt).length <= 6500);
  assert.ok(Object.values(sections(txt)).every(s => s.length >= 1));
});
