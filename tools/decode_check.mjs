// offline check: decode packets.json with the Worker's own parser (usage: node decode_check.mjs packets.json chk_key_file)
import { readFileSync } from "node:fs";
import { parsePacket } from "../worker/src/index.js";
const d = JSON.parse(readFileSync(process.argv[2], "utf8"));
const key = parseInt(readFileSync(process.argv[3], "utf8").trim(), 10);
for (const p of d) {
  const syms = p.urls.slice(1, -1).map(u => +u.split("/s/")[1]);
  const r = parsePacket(syms, key);
  console.log(p.id.padEnd(18), r.err ? "ERR " + r.err : (r.relay ? "relay " : "self  ") + JSON.stringify(r.name) + " " + JSON.stringify(r.recs));
}
