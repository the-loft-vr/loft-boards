-- THE LOFT global leaderboards (Cloudflare D1)
-- scores: best per display name per board. self = sent by that player, relay = carried by someone else.
-- best = self if the player ever sent it themselves, else relay (a relayed copy never overrides a self score).
CREATE TABLE IF NOT EXISTS scores (
  board INTEGER NOT NULL,
  name  TEXT    NOT NULL,
  self  INTEGER,
  relay INTEGER,
  best  INTEGER NOT NULL,
  ts    INTEGER NOT NULL,
  PRIMARY KEY (board, name)
);
CREATE INDEX IF NOT EXISTS scores_rank ON scores (board, best DESC);

-- one submission in progress per client (hashed IP with a daily salt; rows live a few minutes)
CREATE TABLE IF NOT EXISTS streams (
  ip   TEXT PRIMARY KEY,
  t0   INTEGER NOT NULL,
  t    INTEGER NOT NULL,
  n    INTEGER NOT NULL,
  syms TEXT    NOT NULL
);

-- daily counters per hashed IP (the hash changes every day; old days are deleted)
CREATE TABLE IF NOT EXISTS rl (
  day     TEXT    NOT NULL,
  ip      TEXT    NOT NULL,
  packets INTEGER NOT NULL DEFAULT 0,
  relays  INTEGER NOT NULL DEFAULT 0,
  bad     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ip)
);

-- removed scores: board -1 = every board; a later score for that name is accepted only if it is higher than maxv
CREATE TABLE IF NOT EXISTS tomb (
  board INTEGER NOT NULL,
  name  TEXT    NOT NULL,
  maxv  INTEGER NOT NULL,
  ts    INTEGER NOT NULL,
  PRIMARY KEY (board, name)
);
