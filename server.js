// Secret Crush — anonymous office crush counter.
// Zero dependencies: run with `node server.js` (Node 18+).
//
// Privacy model: colleagues only ever see per-name totals. Each ballot
// (voter -> crushes) is also recorded and visible to the admin only — the
// voting page tells voters this up front.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const MAX_CRUSHES = Number(process.env.MAX_CRUSHES) || 3;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');
const ROSTER_FILE = path.join(__dirname, 'roster.txt');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Salt for voter hashes, created once and kept on disk.
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'));
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();

const ADMIN_KEY = process.env.ADMIN_KEY || crypto.createHash('sha256').update('admin:' + SECRET).digest('hex').slice(0, 12);

function emptyDb() {
  return { open: true, revealed: false, counts: {}, voters: [], ballots: [] };
}

function loadDb() {
  try {
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    return emptyDb();
  }
}

let db = loadDb();

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const normalize = (name) => String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const keyOf = (name) => normalize(name).toLowerCase();
const titleCase = (name) => normalize(name).replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());

// Optional roster: one colleague per line in roster.txt. When present, names
// must come from it (no typos, no "Batman"); otherwise any name is accepted.
function loadRoster() {
  if (!fs.existsSync(ROSTER_FILE)) return null;
  const names = fs.readFileSync(ROSTER_FILE, 'utf8').split(/\r?\n/).map(normalize).filter(Boolean);
  return names.length ? new Map(names.map((n) => [keyOf(n), n])) : null;
}

function canonical(name, roster) {
  const n = normalize(name);
  if (!n || n.length > 60) return null;
  if (roster) return roster.get(keyOf(n)) || null;
  return titleCase(n);
}

function voterHash(name) {
  return crypto.createHmac('sha256', SECRET).update(keyOf(name)).digest('hex');
}

function leaderboard() {
  return Object.values(db.counts)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map((e, i, all) => ({ ...e, rank: all.findIndex((x) => x.count === e.count) + 1 }));
}

function publicState() {
  const roster = loadRoster();
  return {
    open: db.open,
    revealed: db.revealed,
    maxCrushes: MAX_CRUSHES,
    voterCount: db.voters.length,
    roster: roster ? [...roster.values()].sort((a, b) => a.localeCompare(b)) : null,
    leaderboard: db.revealed ? leaderboard().slice(0, 10) : null,
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 10_000) reject(new Error('too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { reject(new Error('bad json')); }
    });
  });
}

function handleVote(body) {
  if (!db.open) return [403, { error: 'Voting is closed.' }];
  const roster = loadRoster();

  const me = canonical(body.voter, roster);
  if (!me) return [400, { error: roster ? 'Pick your own name from the list.' : 'Enter your name.' }];

  const hash = voterHash(me);
  if (db.voters.includes(hash)) return [409, { error: "You've already submitted. Your secret is safe!" }];

  const picks = Array.isArray(body.crushes) ? body.crushes : [];
  const chosen = new Map();
  for (const raw of picks) {
    if (!normalize(raw)) continue;
    const c = canonical(raw, roster);
    if (!c) return [400, { error: `"${normalize(raw)}" isn't on the colleague list.` }];
    if (keyOf(c) === keyOf(me)) return [400, { error: "Nice try — you can't crush on yourself 😄" }];
    chosen.set(keyOf(c), c);
  }
  if (chosen.size === 0) return [400, { error: 'Enter at least one crush.' }];
  if (chosen.size > MAX_CRUSHES) return [400, { error: `You can pick up to ${MAX_CRUSHES} crushes.` }];

  for (const [k, name] of chosen) {
    db.counts[k] = { name, count: (db.counts[k]?.count || 0) + 1 };
  }
  db.voters.push(hash);
  db.ballots.push({ voter: me, crushes: [...chosen.values()], at: new Date().toISOString() });
  saveDb();
  return [200, { ok: true }];
}

function handleAdmin(action) {
  switch (action) {
    case 'status': break;
    case 'open': db.open = true; break;
    case 'close': db.open = false; break;
    case 'reveal': db.revealed = true; break;
    case 'hide': db.revealed = false; break;
    case 'reset': db = emptyDb(); break;
    default: return [400, { error: 'Unknown action' }];
  }
  if (action !== 'status') saveDb();
  return [200, { open: db.open, revealed: db.revealed, voterCount: db.voters.length, leaderboard: leaderboard(), ballots: db.ballots }];
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname === '/' ? '/index.html' : url.pathname === '/admin' ? '/admin.html' : url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(p));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, publicState());
    if (url.pathname === '/api/vote' && req.method === 'POST') return send(res, ...handleVote(await readJson(req)));
    if (url.pathname === '/api/admin' && req.method === 'POST') {
      const body = await readJson(req);
      const given = Buffer.from(String(body.key || ''));
      const expected = Buffer.from(ADMIN_KEY);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
        return send(res, 401, { error: 'Wrong admin key.' });
      }
      return send(res, ...handleAdmin(body.action));
    }
    if (req.method === 'GET') return serveStatic(req, res);
    send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`💘 Secret Crush running at http://localhost:${PORT}`);
  console.log(`   Admin panel: http://localhost:${PORT}/admin   (key: ${ADMIN_KEY})`);
  console.log(loadRoster() ? '   Using roster.txt for names.' : '   No roster.txt — any name accepted.');
});
