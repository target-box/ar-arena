// AR Arena - server: static files + WebSocket multiplayer
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let u;
  try { u = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (u === '/') u = '/index.html';
  const f = path.normalize(path.join(PUB, u));
  if (!f.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(data);
  });
});

const MAX_PLAYERS = 20;
const MAX_RANGE = 120;
const DAMAGE = 25;
const RESPAWN_MS = 3000;
const SHOT_COOLDOWN_MS = 200;
const MIN_TOL = 6 * Math.PI / 180;
const COLORS = ['#ff3b6b', '#ffd23b', '#3bffb0', '#3bb7ff', '#b43bff', '#ff8a3b', '#9dff3b', '#ff3bf0'];

const rooms = new Map();
let nextId = 1;

const num = (v, lim = 1e9) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim) ? v : null;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };

function getRoom(code) {
  if (!rooms.has(code)) rooms.set(code, { code, players: new Map(), origin: null });
  return rooms.get(code);
}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}

function handleShoot(room, me, yaw, pitch) {
  const now = Date.now();
  if (me.deadUntil > now || now - me.lastShot < SHOT_COOLDOWN_MS) return;
  me.lastShot = now;
  broadcast(room, { t: 'shot', id: me.id });

  let best = null, bestD = Infinity;
  for (const p of room.players.values()) {
    if (p === me || p.deadUntil > now) continue;
    const dx = p.x - me.x, dy = p.y - me.y;
    const D = Math.max(Math.hypot(dx, dy), 0.5);
    if (D > MAX_RANGE) continue;
    const dh = Math.abs(angDiff(Math.atan2(dx, dy), yaw));
    const tolH = Math.max(Math.atan(0.8 / D), MIN_TOL);
    const pitchT = Math.atan2(-0.3, D);
    const tolV = Math.max(Math.atan(0.9 / D), MIN_TOL);
    if (dh <= tolH && Math.abs(pitch - pitchT) <= tolV && D < bestD) { best = p; bestD = D; }
  }
  if (!best) return;

  best.hp -= DAMAGE;
  const killed = best.hp <= 0;
  if (killed) {
    best.hp = 0;
    best.deadUntil = now + RESPAWN_MS;
    best.deaths++;
    me.score++;
  }
  broadcast(room, { t: 'hit', by: me.id, target: best.id, hp: best.hp, killed, byName: me.name, targetName: best.name });
}

const wss = new WebSocketServer({ server, maxPayload: 2048 });

wss.on('connection', (ws) => {
  let me = null, room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join' && !me) {
      const code = String(m.room || 'MAIN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'MAIN';
      room = getRoom(code);
      if (room.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', msg: 'Room is full' }); return ws.close(); }
      const name = String(m.name || '').replace(/[<>&"']/g, '').trim().slice(0, 16) || 'Player' + nextId;
      const id = nextId++;
      me = {
        id, ws, name,
        x: (Math.random() - 0.5) * 24, y: (Math.random() - 0.5) * 24,
        hp: 100, score: 0, deaths: 0, deadUntil: 0, lastShot: 0,
        color: COLORS[id % COLORS.length],
      };
      room.players.set(id, me);
      send(ws, { t: 'welcome', id, room: code });
      return;
    }
    if (!me) return;

    if (m.t === 'pos') {
      const lat = num(m.lat, 90), lon = num(m.lon, 180);
      if (lat === null || lon === null) return;
      if (!room.origin) room.origin = { lat, lon };
      const o = room.origin;
      me.x = Math.max(-5000, Math.min(5000, (lon - o.lon) * 111320 * Math.cos(o.lat * Math.PI / 180)));
      me.y = Math.max(-5000, Math.min(5000, (lat - o.lat) * 110540));
    } else if (m.t === 'shoot') {
      const yaw = num(m.yaw, 10), pitch = num(m.pitch, 10);
      if (yaw === null || pitch === null) return;
      handleShoot(room, me, yaw, pitch);
    }
  });

  ws.on('close', () => {
    if (!me) return;
    room.players.delete(me.id);
    if (room.players.size === 0) rooms.delete(room.code);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (p.deadUntil && now >= p.deadUntil) { p.deadUntil = 0; p.hp = 100; }
    }
    broadcast(room, {
      t: 'state',
      players: [...room.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color,
        x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
        hp: p.hp, score: p.score, deaths: p.deaths, dead: p.deadUntil > now,
      })),
    });
  }
}, 100);

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log('AR Arena listening on port ' + PORT));
