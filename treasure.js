// Treasure hunt - server module (attached to the existing WebSocketServer)
// In : t_join {pid,name,demo} | t_pos {lat,lon,acc} | t_open {id}
// Out: t_state t_loot t_fail t_error
// Chests are generated deterministically from GPS grid cells, so they exist everywhere.
module.exports = function (wss) {
  const CELL_M = 80;            // grid cell size in meters
  const CHEST_P = 0.4;          // probability that a cell has a chest
  const VISIBLE_M = 400;        // chests sent to the client
  const PLAYER_VIS_M = 1000;    // other players shown on the map
  const OPEN_M = 35;            // server tolerance for opening (client uses 25 m)
  const RESPAWN_MS = 15 * 60 * 1000;
  const PRIZE_AT = 5;           // chests needed for the prize code
  const PRIZE_CODE = process.env.PRIZE_CODE || '';
  const MAX_PLAYERS = 300;
  const KINDS = [
    { k: 'wood', pts: 10 },
    { k: 'silver', pts: 30 },
    { k: 'gold', pts: 100 },
  ];
  const COLORS = ['#ff3b6b', '#ffd23b', '#3bffb0', '#3bb7ff', '#b43bff', '#ff8a3b', '#9dff3b', '#ff3bf0'];
  const D2R = Math.PI / 180;
  const DLAT = CELL_M / 110540;

  const players = new Set();
  const profiles = new Map();   // pid -> {name, points, found, demo}
  const taken = new Map();      // chest id -> respawn time
  let nextId = 1;

  function rnd(ix, iy, salt) {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(salt, -2048144777);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const dLonRow = (iy) => DLAT / Math.cos((iy + 0.5) * DLAT * D2R);

  function chestAt(ix, iy) {
    if (rnd(ix, iy, 1) >= CHEST_P) return null;
    const dl = dLonRow(iy);
    const r = rnd(ix, iy, 4);
    const kind = r < 0.7 ? 0 : (r < 0.95 ? 1 : 2);
    return {
      id: ix + ':' + iy,
      lat: (iy + 0.1 + 0.8 * rnd(ix, iy, 2)) * DLAT,
      lon: (ix + 0.1 + 0.8 * rnd(ix, iy, 3)) * dl,
      kind,
    };
  }

  function dist(lat1, lon1, lat2, lon2) {
    const dx = (lon2 - lon1) * 111320 * Math.cos(lat1 * D2R);
    const dy = (lat2 - lat1) * 110540;
    return Math.hypot(dx, dy);
  }

  function chestsNear(lat, lon, now) {
    const out = [];
    const iy0 = Math.floor((lat - VISIBLE_M / 110540) / DLAT);
    const iy1 = Math.floor((lat + VISIBLE_M / 110540) / DLAT);
    for (let iy = iy0; iy <= iy1; iy++) {
      const dl = dLonRow(iy);
      const span = VISIBLE_M / (111320 * Math.cos(lat * D2R)) ;
      const ix0 = Math.floor((lon - span) / dl), ix1 = Math.floor((lon + span) / dl);
      for (let ix = ix0; ix <= ix1; ix++) {
        const c = chestAt(ix, iy);
        if (!c) continue;
        const until = taken.get(c.id);
        if (until && until > now) continue;
        if (dist(lat, lon, c.lat, c.lon) > VISIBLE_M) continue;
        out.push({ id: c.id, lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6), k: KINDS[c.kind].k });
      }
    }
    return out;
  }

  const send = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
  const num = (v, lim) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim) ? v : null;
  const clean = (s, n) => String(s || '').replace(/[<>&"']/g, '').trim().slice(0, n);

  function topList() {
    return [...profiles.values()].filter((p) => !p.demo && p.points > 0)
      .sort((a, b) => b.points - a.points).slice(0, 5).map((p) => ({ name: p.name, points: p.points, found: p.found }));
  }

  wss.on('connection', (ws) => {
    const p = { ws, id: 0, prof: null, lat: null, lon: null, acc: 0, posAt: 0, lastOpen: 0 };

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m.t !== 'string' || m.t.slice(0, 2) !== 't_') return;

      if (m.t === 't_join' && !p.prof) {
        if (players.size >= MAX_PLAYERS) return send(p, { t: 't_error', msg: 'Сървърът е пълен' });
        const demo = !!m.demo;
        const pid = String(m.pid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || ('x' + Math.random().toString(36).slice(2, 10));
        const key = pid + (demo ? 'd' : '');
        let prof = profiles.get(key);
        if (!prof) { prof = { name: '', points: 0, found: 0, demo }; profiles.set(key, prof); }
        prof.name = clean(m.name, 14) || 'Ловец';
        p.prof = prof; p.id = nextId++; p.color = COLORS[p.id % COLORS.length];
        players.add(p);
        return;
      }
      if (!p.prof) return;

      if (m.t === 't_pos') {
        const lat = num(m.lat, 90), lon = num(m.lon, 180);
        if (lat === null || lon === null) return;
        p.lat = lat; p.lon = lon; p.acc = Math.min(num(m.acc, 1e5) || 0, 9999); p.posAt = Date.now();
      } else if (m.t === 't_open') {
        const now = Date.now();
        if (now - p.lastOpen < 400) return;
        p.lastOpen = now;
        const id = String(m.id || '');
        const mt = /^(-?\d{1,9}):(-?\d{1,9})$/.exec(id);
        if (!mt || p.lat === null || now - p.posAt > 20000) return send(p, { t: 't_fail', id, reason: 'pos' });
        const c = chestAt(parseInt(mt[1], 10), parseInt(mt[2], 10));
        if (!c) return send(p, { t: 't_fail', id, reason: 'none' });
        const until = taken.get(c.id);
        if (until && until > now) return send(p, { t: 't_fail', id, reason: 'taken' });
        const d = dist(p.lat, p.lon, c.lat, c.lon);
        if (d > OPEN_M + Math.min(p.acc, 20)) return send(p, { t: 't_fail', id, reason: 'far', d: Math.round(d) });
        taken.set(c.id, now + RESPAWN_MS);
        const kd = KINDS[c.kind];
        p.prof.points += kd.pts; p.prof.found++;
        const out = { t: 't_loot', id, k: kd.k, pts: kd.pts, total: p.prof.points, found: p.prof.found };
        if (!p.prof.demo && PRIZE_CODE && p.prof.found >= PRIZE_AT) out.prize = PRIZE_CODE;
        send(p, out);
      }
    });

    ws.on('close', () => { players.delete(p); });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, until] of taken) if (until <= now) taken.delete(id);
    const top = topList();
    for (const p of players) {
      if (p.lat === null) continue;
      const others = [];
      for (const q of players) {
        if (q === p || q.lat === null || now - q.posAt > 30000) continue;
        if (dist(p.lat, p.lon, q.lat, q.lon) > PLAYER_VIS_M) continue;
        others.push({ id: q.id, name: q.prof.name, lat: +q.lat.toFixed(6), lon: +q.lon.toFixed(6), c: q.color });
      }
      send(p, {
        t: 't_state',
        chests: chestsNear(p.lat, p.lon, now),
        players: others,
        me: { points: p.prof.points, found: p.prof.found },
        top, online: players.size, prizeAt: PRIZE_AT, hasPrize: !!PRIZE_CODE,
      });
    }
  }, 1000);
};
