// THE LOFT global leaderboards: score intake + export (Cloudflare Worker + D1).
//
// The VRChat world cannot build URLs or POST, so it holds a baked table of GET URLs:
//   /b          begin a submission (resets this client's stream)
//   /s/<0..1023> one 10-bit symbol of the submission
//   /e          end: the server checks and stores the submission, answers "ok <n>" or "bad <why>"
// Requests come one at a time (VRChat allows one string load per 5 s), so they arrive in order. A stream is keyed by
// the client's IP, hashed with a salt that changes every day (no IP is stored).
//
// Submission bits (MSB first, packed into 10-bit symbols, zero padded), then 2 checksum symbols:
//   version 3 (=1) | relay 1 | name length 7 (bytes) | name UTF-8 | records 4 (1..11) | per record: board 4, bits 5, value <bits>
//   checksum: h = CHK_KEY; for each data symbol s: h = (h * 1103 + s + 7) % 1048573 -> symbols h >> 10, h & 1023
//
// Public:  /export (the compact board text the GitHub Action publishes), /health
// Admin:   /admin (page), /admin/api/* with "Authorization: Bearer <ADMIN_KEY>"
//
// Secrets (wrangler secret put): ADMIN_KEY, CHK_KEY (also baked into the world), IP_SALT.

const NB = 11;
const TOP = 20;               // entries per board in the export (fewer if the byte budget runs out)
const BUDGET = 6500;          // export bytes (the iPad cuts string downloads at about 8 KB)
const TOMB_EXPORT = 40;       // most recent removals listed in the export (clients drop them from carried lists)
const MAX_SYMS = 140;
const STREAM_IDLE_MS = 120000;
const STREAM_MAX_MS = 1200000;
const MIN_GAP_MS = 2000;      // VRChat spaces string loads 5 s apart; faster than this is not a VRChat client
const DAY_PACKETS = 80, DAY_RELAYS = 150, DAY_BAD = 15;
const LAUNCH = Date.UTC(2026, 10, 5);   // the boards started on 2026-11-06 (r30); one day of slack
const BOARD_NAMES = ["Beer pong: longest streak", "Beer pong: most wins", "Loft Regulars: most visits", "Loft Regulars: time (seconds)",
  "Wheel: most spins", "Kon: most betrayed", "Lucky Shot: survivals", "Lucky Shot: deaths", "Lucky Shot: wins",
  "Guess Me!: best round", "Guess Me!: total guessed"];
const HARD_CAP = [1000, 100000, 100000, 720000000, 100000, 100000, 100000, 100000, 100000, 1000, 100000];   // the world's own caps

// plausible maxima for one player, from the game code (generous: playing non-stop since the launch)
function capFor(board, now) {
  const days = Math.max(1, Math.ceil((now - LAUNCH) / 86400000));
  let c;
  switch (board) {
    case 0: c = 40; break;                      // streak within one game: 10 cups per side, up to 3 opponents
    case 1: c = 300 * days; break;              // pong wins: a game takes minutes
    case 2: c = 4 * days + 4; break;            // visits: +1 per 6 h
    case 3: c = 86400 * days + 3600; break;     // seconds in the Loft
    case 4: c = 3000 * days; break;             // wheel spins (alternating spinners, ~10 s a spin)
    case 5: c = 1500 * days; break;             // betrayed bribes (1 in 3 bribes, one per turn)
    case 6: c = 3000 * days; break;             // Lucky Shot survivals
    case 7: c = 1500 * days; break;             // Lucky Shot deaths
    case 8: c = 600 * days; break;              // Lucky Shot wins
    case 9: c = 30; break;                      // Guess Me! words in one 60 s round
    case 10: c = 3000 * days; break;            // Guess Me! total correct guesses (plus the per-submission jump check)
    default: return 0;
  }
  return Math.min(c, HARD_CAP[board]);
}

// Guess Me! total guessed: a count that grows by at most ~30 a round (60 s rounds); a jump over the last stored value must
// fit the time since then (at least 40 is always allowed)
const TOTAL_BOARD = 10;
function jumpOk(prev, prevTs, v, now) {
  if (prev === null || prev === undefined) return true;
  return v - prev <= Math.max(40, Math.ceil((now - prevTs) / 60000) * 30);
}

// PG: names that are obviously abusive are refused (base64 so the repo stays clean). Substring match, lower case.
const BAD_B64 = ["bmlnZ2Vy", "bmlnZ2E=", "ZmFnZ290", "cmV0YXJk", "a2lrZQ==", "Y2hpbms=", "c3BpYw==", "dHJhbm55", "aGl0bGVy", "bmF6aQ==",
  "cmFwZQ==", "cGVkbw==", "Y3VudA==", "d2hvcmU=", "c2x1dA==", "Y29jaw==", "cGVuaXM=", "dmFnaW5h", "cG9ybg==", "a2tr", "c2llZw=="];
let BAD = null;
function badName(name) {
  if (!BAD) BAD = BAD_B64.map(b => atob(b));
  const n = name.toLowerCase().replace(/[\s_.\-|]+/g, "").replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/5/g, "s").replace(/\$/g, "s").replace(/@/g, "a");
  return BAD.some(w => n.includes(w));
}

// the world's own clean-up of display names (LoftWallBoard30.San): no control characters, trimmed, at most 24 UTF-16 units
function cleanName(s) {
  let o = "";
  for (const ch of s) { const x = ch.codePointAt(0); if (x < 32 || x === 127 || x === 0x2028 || x === 0x2029) continue; o += ch; }
  o = o.trim();
  if (o.length > 24) { let cut = 24; const x = o.charCodeAt(cut - 1); if (x >= 0xD800 && x <= 0xDBFF) cut--; o = o.substring(0, cut); }
  return o;
}

const TXT = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
const txt = (s, status = 200) => new Response(s, { status, headers: TXT });

async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}
const today = now => new Date(now).toISOString().slice(0, 10);
async function ipHash(req, env, now) {
  const ip = req.headers.get("cf-connecting-ip") || "0";
  return sha(ip + "|" + today(now) + "|" + (env.IP_SALT || "salt"));
}

export function checksum(key, syms) {
  let h = key % 1048573;
  for (const s of syms) h = (h * 1103 + s + 7) % 1048573;
  return h;
}

// parse a finished stream -> { relay, name, recs: [[board, value]] } or { err }
export function parsePacket(syms, key) {
  if (syms.length < 4) return { err: "short" };
  const data = syms.slice(0, -2), h = syms[syms.length - 2] * 1024 + syms[syms.length - 1];
  if (checksum(key, data) !== h) return { err: "checksum" };
  const bits = [];
  for (const s of data) for (let i = 9; i >= 0; i--) bits.push((s >> i) & 1);
  let p = 0;
  const take = n => { if (p + n > bits.length) throw new Error("eof"); let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bits[p++]; return v; };
  try {
    if (take(3) !== 1) return { err: "version" };
    const relay = take(1) === 1;
    const nl = take(7);
    if (nl < 1 || nl > 96) return { err: "namelen" };
    const nb = new Uint8Array(nl);
    for (let i = 0; i < nl; i++) nb[i] = take(8);
    let name;
    try { name = new TextDecoder("utf-8", { fatal: true }).decode(nb); } catch { return { err: "utf8" }; }
    const nr = take(4);
    if (nr < 1 || nr > NB) return { err: "records" };
    const recs = [], seen = new Set();
    for (let r = 0; r < nr; r++) {
      const b = take(4), k = take(5);
      if (b >= NB || seen.has(b) || k < 1 || k > 30) return { err: "record" };
      seen.add(b);
      recs.push([b, take(k)]);
    }
    if (bits.length - p >= 10) return { err: "trailing" };
    while (p < bits.length) if (bits[p++] !== 0) return { err: "padding" };
    return { relay, name, recs };
  } catch { return { err: "eof" }; }
}

async function rlRow(env, day, ip) {
  return await env.DB.prepare("SELECT packets, relays, bad FROM rl WHERE day=? AND ip=?").bind(day, ip).first();
}
async function rlAdd(env, day, ip, col, n) {
  await env.DB.prepare(`INSERT INTO rl (day, ip, ${col}) VALUES (?, ?, ?) ON CONFLICT(day, ip) DO UPDATE SET ${col} = ${col} + excluded.${col}`).bind(day, ip, n).run();
}

async function begin(req, env, now) {
  const ip = await ipHash(req, env, now), day = today(now);
  const r = await rlRow(env, day, ip);
  if (r && (r.packets >= DAY_PACKETS || r.bad >= DAY_BAD)) return txt("rl");
  await env.DB.prepare("INSERT INTO streams (ip, t0, t, n, syms) VALUES (?, ?, ?, 0, '') ON CONFLICT(ip) DO UPDATE SET t0=excluded.t0, t=excluded.t, n=0, syms=''").bind(ip, now, now).run();
  await rlAdd(env, day, ip, "packets", 1);
  // housekeeping (cheap): old streams and old days
  if (Math.random() < 0.2) await env.DB.batch([
    env.DB.prepare("DELETE FROM streams WHERE t < ?").bind(now - STREAM_MAX_MS),
    env.DB.prepare("DELETE FROM rl WHERE day <> ?").bind(day)]);
  return txt("0");
}

async function symbol(req, env, now, s) {
  const ip = await ipHash(req, env, now);
  const row = await env.DB.prepare("SELECT t0, t, n FROM streams WHERE ip=?").bind(ip).first();
  if (!row || now - row.t > STREAM_IDLE_MS || now - row.t0 > STREAM_MAX_MS || row.n >= MAX_SYMS) return txt("x");
  if (now - row.t < MIN_GAP_MS) { await env.DB.prepare("DELETE FROM streams WHERE ip=?").bind(ip).run(); return txt("x"); }
  const r = await env.DB.prepare("UPDATE streams SET syms = CASE WHEN n = 0 THEN ? ELSE syms || ',' || ? END, n = n + 1, t = ? WHERE ip = ? AND n = ? RETURNING n")
    .bind(String(s), String(s), now, ip, row.n).first();
  return txt(r ? String(r.n) : "x");
}

async function end(req, env, now) {
  const ip = await ipHash(req, env, now), day = today(now);
  const row = await env.DB.prepare("DELETE FROM streams WHERE ip=? RETURNING t0, t, n, syms").bind(ip).first();
  if (!row || now - row.t > STREAM_IDLE_MS || row.n === 0) return txt("bad nostream");
  const syms = row.syms.split(",").map(Number);
  const pk = parsePacket(syms, parseInt(env.CHK_KEY || "0", 10));
  if (pk.err) { await rlAdd(env, day, ip, "bad", 1); return txt("bad " + pk.err); }
  const name = cleanName(pk.name);
  if (!name || name !== pk.name) { await rlAdd(env, day, ip, "bad", 1); return txt("bad name"); }
  if (badName(name)) return txt("ok 0");   // quietly ignored (the client must not retry)
  if (pk.relay) {
    const r = await rlRow(env, day, ip);
    if (r && r.relays + pk.recs.length > DAY_RELAYS) return txt("ok 0");
    await rlAdd(env, day, ip, "relays", pk.recs.length);
  }
  const res = await store(env, name, pk.recs, pk.relay, now);
  return txt("ok " + res);
}

// store records; returns how many changed the board
async function store(env, name, recs, relay, now) {
  const tombs = await env.DB.prepare("SELECT board, maxv FROM tomb WHERE name=?").bind(name).all();
  const tb = new Map(); for (const t of tombs.results) tb.set(t.board, t.maxv);
  let changed = 0;
  for (const [b, v] of recs) {
    if (v <= 0 || v > capFor(b, now)) continue;
    const dead = Math.max(tb.has(b) ? tb.get(b) : 0, tb.has(-1) ? tb.get(-1) : 0);
    if (v <= dead) continue;
    const cur = await env.DB.prepare("SELECT self, relay, ts FROM scores WHERE board=? AND name=?").bind(b, name).first();
    let self = cur ? cur.self : null, rel = cur ? cur.relay : null;
    if (b === TOTAL_BOARD && cur && !jumpOk(relay ? rel : self, cur.ts, v, now)) continue;
    if (relay) { if (self !== null) continue; if (rel !== null && rel >= v) continue; rel = v; }
    else { if (self !== null && self >= v) continue; self = v; }
    const best = self !== null ? self : rel;
    await env.DB.prepare("INSERT INTO scores (board, name, self, relay, best, ts) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(board, name) DO UPDATE SET self=excluded.self, relay=excluded.relay, best=excluded.best, ts=excluded.ts")
      .bind(b, name, self, rel, best, now).run();
    changed++;
  }
  return changed;
}

const ord = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const utf8len = s => new TextEncoder().encode(s).length;

// the compact board text: "LB1", then "#x" removals ("board\tname\tmaxv", board * = all), then "#0".."#8" with "name\tvalue" lines
async function exportText(env) {
  const now = Date.now();
  const lists = [];
  for (let b = 0; b < NB; b++) {
    const r = await env.DB.prepare("SELECT name, best FROM scores WHERE board=? ORDER BY best DESC LIMIT ?").bind(b, TOP + 20).all();
    const rows = r.results.filter(x => x.best > 0 && x.best <= capFor(b, now) && !badName(x.name));
    rows.sort((x, y) => (y.best - x.best) || ord(x.name, y.name));
    lists.push(rows.slice(0, TOP));
  }
  const tombs = (await env.DB.prepare("SELECT board, name, maxv FROM tomb ORDER BY ts DESC LIMIT ?").bind(TOMB_EXPORT).all()).results;
  let out = "LB1\n", used = 4;
  let xs = "";
  for (const t of tombs) { const l = (t.board < 0 ? "*" : String(t.board)) + "\t" + t.name + "\t" + t.maxv + "\n"; if (used + 3 + utf8len(xs + l) > 1500) break; xs += l; }
  if (xs) { out += "#x\n" + xs; used += 3 + utf8len(xs); }
  // round robin by rank so every board gets its top places before any board gets more
  const take = new Array(NB).fill(0);
  used += NB * 3;
  for (let rank = 0; rank < TOP; rank++) {
    let any = false;
    for (let b = 0; b < NB; b++) {
      const e = lists[b][rank]; if (!e) continue;
      const c = utf8len(e.name + "\t" + e.best + "\n");
      if (used + c > BUDGET) continue;
      used += c; take[b] = rank + 1; any = true;
    }
    if (!any) break;
  }
  for (let b = 0; b < NB; b++) {
    out += "#" + b + "\n";
    for (let i = 0; i < take[b]; i++) out += lists[b][i].name + "\t" + lists[b][i].best + "\n";
  }
  return out;
}

// ---------------------------------------------------------------- admin
function authed(req, env) {
  const h = req.headers.get("authorization") || "";
  const want = "Bearer " + (env.ADMIN_KEY || "");
  if (!env.ADMIN_KEY || h.length !== want.length) return false;
  let d = 0; for (let i = 0; i < h.length; i++) d |= h.charCodeAt(i) ^ want.charCodeAt(i);
  return d === 0;
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function admin(req, env, path) {
  if (!authed(req, env)) return json({ error: "unauthorized" }, 401);
  const now = Date.now();
  let body = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { body = {}; } }
  const url = new URL(req.url);
  if (path === "/admin/api/boards") {
    const out = [];
    for (let b = 0; b < NB; b++) {
      const r = await env.DB.prepare("SELECT name, self, relay, best, ts FROM scores WHERE board=? ORDER BY best DESC LIMIT 200").bind(b).all();
      out.push({ board: b, title: BOARD_NAMES[b], cap: capFor(b, now), rows: r.results });
    }
    const tombs = (await env.DB.prepare("SELECT board, name, maxv, ts FROM tomb ORDER BY ts DESC LIMIT 500").all()).results;
    return json({ boards: out, removed: tombs });
  }
  if (path === "/admin/api/search") {
    const q = url.searchParams.get("q") || "";
    const r = await env.DB.prepare("SELECT board, name, self, relay, best, ts FROM scores WHERE name LIKE ? ORDER BY board, best DESC LIMIT 200").bind("%" + q + "%").all();
    return json({ rows: r.results });
  }
  if (req.method !== "POST") return json({ error: "use POST" }, 405);
  const name = typeof body.name === "string" ? body.name : "";
  const board = Number.isInteger(body.board) ? body.board : -2;
  if (path === "/admin/api/delete") {          // remove one score; that name only comes back with a higher score
    if (!name || board < 0 || board >= NB) return json({ error: "need board 0-10 and name" }, 400);
    const cur = await env.DB.prepare("DELETE FROM scores WHERE board=? AND name=? RETURNING best").bind(board, name).first();
    const maxv = Math.max(cur ? cur.best : 0, Number.isInteger(body.maxv) ? body.maxv : 0);
    await env.DB.prepare("INSERT INTO tomb (board, name, maxv, ts) VALUES (?, ?, ?, ?) ON CONFLICT(board, name) DO UPDATE SET maxv=max(maxv, excluded.maxv), ts=excluded.ts").bind(board, name, maxv, now).run();
    return json({ deleted: !!cur, board, name, maxv });
  }
  if (path === "/admin/api/block") {           // remove every score of a name and refuse it from now on
    if (!name) return json({ error: "need name" }, 400);
    const r = await env.DB.prepare("DELETE FROM scores WHERE name=?").bind(name).run();
    await env.DB.prepare("INSERT INTO tomb (board, name, maxv, ts) VALUES (-1, ?, 2147483647, ?) ON CONFLICT(board, name) DO UPDATE SET maxv=2147483647, ts=excluded.ts").bind(name, now).run();
    return json({ blocked: name, removed: r.meta.changes });
  }
  if (path === "/admin/api/unblock") {         // forget a removal (board -1 = the block); the scores themselves stay deleted
    if (!name) return json({ error: "need name" }, 400);
    const r = await env.DB.prepare("DELETE FROM tomb WHERE name=? AND (board=? OR ?=-2)").bind(name, board, board).run();
    return json({ unblocked: name, rows: r.meta.changes });
  }
  if (path === "/admin/api/wipe") {            // empty everything (scores, removals, streams, counters)
    if (body.confirm !== "WIPE") return json({ error: "send {\"confirm\":\"WIPE\"}" }, 400);
    await env.DB.batch(["scores", "tomb", "streams", "rl"].map(t => env.DB.prepare("DELETE FROM " + t)));
    return json({ wiped: true });
  }
  return json({ error: "unknown" }, 404);
}

const ADMIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loft boards admin</title><style>
body{font:14px system-ui,sans-serif;margin:16px;background:#14181a;color:#e8e2d0}input,button{font:inherit;padding:6px 10px;margin:2px;border-radius:6px;border:1px solid #555;background:#222;color:#eee}
button{cursor:pointer;background:#3a3222;border-color:#c9a35e}button.x{background:#4a1f1f;border-color:#c55}table{border-collapse:collapse;margin:6px 0 18px}td,th{padding:3px 10px;border-bottom:1px solid #333;text-align:left}
h2{color:#c9a35e;margin:18px 0 4px;font-size:16px}.dim{color:#999}</style></head><body>
<h1>THE LOFT global boards</h1>
<p><input id="k" type="password" placeholder="admin key" size="40"> <button onclick="go()">Load</button> <span id="st" class="dim"></span></p>
<p><input id="bn" placeholder="name to block on every board" size="30"> <button class="x" onclick="blk()">Block name</button>
<input id="un" placeholder="name to unblock" size="20"> <button onclick="unb()">Unblock</button></p>
<div id="out"></div><script>
const K=()=>document.getElementById('k').value.trim();try{document.getElementById('k').value=sessionStorage.getItem('k')||''}catch(e){}
async function api(p,b){try{sessionStorage.setItem('k',K())}catch(e){}const r=await fetch(p,{method:b?'POST':'GET',headers:{authorization:'Bearer '+K(),'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return r.json()}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function go(){const d=await api('/admin/api/boards');if(d.error){st.textContent=d.error;return}st.textContent='loaded '+new Date().toLocaleTimeString();let h='';
for(const b of d.boards){h+='<h2>'+b.board+' · '+esc(b.title)+' <span class=dim>(max now '+b.cap+')</span></h2><table><tr><th>#</th><th>name</th><th>score</th><th>self</th><th>relayed</th><th>when</th><th></th></tr>';
b.rows.forEach((r,i)=>{h+='<tr><td>'+(i+1)+'</td><td>'+esc(r.name)+'</td><td>'+r.best+'</td><td>'+(r.self??'')+'</td><td>'+(r.relay??'')+'</td><td class=dim>'+new Date(r.ts).toLocaleString()+'</td><td><button class=x data-b="'+b.board+'" data-n="'+esc(r.name)+'" onclick="del(this)">Delete</button></td></tr>'});h+='</table>'}
h+='<h2>Removed / blocked</h2><table><tr><th>board</th><th>name</th><th>up to</th></tr>';for(const t of d.removed)h+='<tr><td>'+(t.board<0?'all':t.board)+'</td><td>'+esc(t.name)+'</td><td>'+t.maxv+'</td></tr>';out.innerHTML=h+'</table>'}
async function del(e){const n=e.dataset.n,b=+e.dataset.b;if(!confirm('Delete '+n+' from board '+b+'?'))return;await api('/admin/api/delete',{board:b,name:n});go()}
async function blk(){const n=bn.value;if(!n||!confirm('Block '+n+' on every board?'))return;await api('/admin/api/block',{name:n});go()}
async function unb(){const n=un.value;if(!n)return;await api('/admin/api/unblock',{name:n});go()}
</script></body></html>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname, now = Date.now();
    try {
      if (p.startsWith("/s/")) {
        const n = p.slice(3);
        if (!/^\d{1,4}$/.test(n) || +n > 1023) return txt("x", 404);
        return await symbol(req, env, now, +n);
      }
      if (p === "/b") return await begin(req, env, now);
      if (p === "/e") return await end(req, env, now);
      if (p === "/export") return txt(await exportText(env));
      if (p === "/health") return txt("ok");
      if (p === "/admin") return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (p.startsWith("/admin/api/")) return await admin(req, env, p);
      return txt("THE LOFT boards", 404);
    } catch (e) {
      return txt("err", 500);
    }
  },
};
