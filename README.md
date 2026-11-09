# THE LOFT global leaderboards

Global boards for the VRChat world THE LOFT.

- **Read (everyone):** the world downloads `https://moethegreatt.github.io/loft-boards/boards.txt`. GitHub Pages is a
  VRChat-trusted string host, so this works even with *Allow Untrusted URLs* off.
- **Write (players with Allow Untrusted URLs on):** a Cloudflare Worker (`worker/`, D1 database `loft-boards`) at
  `https://loft-boards.theloft.workers.dev`. Udon cannot build URLs or POST, so the world holds a baked table of
  1026 GET URLs (`/b` begin, `/s/0` … `/s/1023` one 10-bit symbol each, `/e` end) and sends a score one request at a
  time (at most one every ~6 s, behind the world's other string loads). See the header of `worker/src/index.js`.
- **Relay:** players who can submit also send the best scores they carried from other players (PlayerData
  carry-merge). Relayed copies are marked; a relayed copy never overrides a score the player sent themselves.
- **Publish:** `.github/workflows/publish.yml` runs every ~10 minutes, fetches `/export` and deploys `site/` to Pages
  when the boards changed. Only the built-in `GITHUB_TOKEN` is used.

## boards.txt format (UTF-8, kept under 6.5 KB: the iPad cuts string downloads at ~8 KB)

```
LB1
#x                      removed scores: board<TAB>name<TAB>up-to-value   (board * = every board)
#0 … #21                one section per board, "name<TAB>value" lines, best first (top 20 for boards 0-10, top 10 for
                        the r39 boards 11-21, fewer if the budget runs out)
```

Boards: 0 beer pong streak, 1 beer pong wins, 2 visits, 3 seconds in the Loft, 4 wheel spins, 5 betrayed by Kon,
6/7/8 Lucky Shot survivals/deaths/wins, 9 Guess Me! best round, 10 Guess Me! total guessed.
r39: 11 most times chosen by Kon, 12/13 Tetrass top score/highest level, 14/15 Bleach Me If You Can top score/highest
level, 16/17 Galax and Relax top score/highest level, 18-21 NES time played in seconds (Super Mario, Tetris, Pac-Man,
Galaga; PC only, listed from 60 s). Packets naming a board above 10 use packet version 2 (5-bit record count and board
ids); version 1 packets from older worlds still work.

## Data and safety

Only display names and scores are stored. IPs are never stored: rate limits use a hash of the IP with a salt that
changes daily, and those rows are deleted the next day. Scores are checked against per-game maxima; obviously abusive
names are refused. The owner can delete scores or block a name (admin page `/admin`, key kept off-repo). The data is
never used to ban anyone.

## Revert

- Stop publishing: disable the workflow (`gh workflow disable publish.yml -R MoeTheGreatt/loft-boards`), or delete the repo.
- Take the Worker down: `cd worker && npx wrangler delete loft-boards`; database: `npx wrangler d1 delete loft-boards`.
- World side: `LoftR34GlobalBoard.RunBoth(false)` in Unity removes the reader/sender from both scenes (the boards then
  work exactly as before, local carry-merge only).

## Tests

`node --test worker/test/worker.test.mjs` (Node 20+, no dependencies): packet versions 1 and 2, the sanity caps, the
listing minimums and the export's size budget.

## Tools

- `tools/decode_check.mjs packets.json <key file>`: decodes URL sequences with the Worker's own parser (offline).
- `tools/simulate.py packets.json [gap]`: replays the exact URL sequences the world sends against the live Worker.
  `packets.json` comes from the world's own packer (`LoftGlobalBoard34._TestPack` in the Unity editor).

Note: GitHub pauses scheduled workflows in a repo with no activity for 60 days. The bot's commits count as activity,
but if the boards do not change for 60 days, re-enable the workflow under Actions (or run it once by hand).
