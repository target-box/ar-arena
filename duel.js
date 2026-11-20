// Wild West Duel - server module (attached to the existing WebSocketServer)
// Messages in : d_join {room,name} | d_tap | d_rematch
// Messages out: d_wait d_start d_ready d_draw d_result d_over d_opp_left d_error
module.exports = function (wss) {
  const WIN_SCORE = 2;          // best of 3
  const READY_MS = 1500;        // "get ready" phase
  const DELAY_MIN = 2000, DELAY_RANGE = 3500; // random wait before the signal
  const GRACE_MS = 350;         // wait for the second tap after the first
  const TIMEOUT_MS = 2500;      // nobody shot after the signal
  const NEXT_ROUND_MS = 3200;

  const duels = new Map();      // code -> duel
  let queueCode = null;         // duel waiting for a random opponent

  const send = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
  const clean = (s, n) => String(s || '').replace(/[<>&"']/g, '').trim().slice(0, n);

  function newDuel(code) {
    const d = { code, players: [], score: [0, 0], round: 0, phase: 'idle', drawAt: 0, timers: [], rematch: new Set() };
    duels.set(code, d);
    return d;
  }
  const later = (d, f, ms) => { const t = setTimeout(f, ms); d.timers.push(t); return t; };
  const clearTimers = (d) => { d.timers.forEach(clearTimeout); d.timers = []; };

  function startMatch(d) {
    clearTimers(d);
    d.score = [0, 0]; d.round = 0; d.rematch.clear();
    d.players.forEach((p, i) => send(p, { t: 'd_start', opp: d.players[1 - i].name }));
    nextRound(d);
  }

  function nextRound(d) {
    clearTimers(d);
    d.round++; d.phase = 'ready';
    d.players.forEach((p) => { p.tapAt = 0; p.adj = null; p.foul = false; });
    d.players.forEach((p, i) => send(p, { t: 'd_ready', round: d.round, score: [d.score[i], d.score[1 - i]] }));
    later(d, () => {
      d.phase = 'wait';
      later(d, () => {
        d.phase = 'draw';
        d.drawAt = Date.now();
        d.players.forEach((p) => send(p, { t: 'd_draw' }));
        later(d, () => resolve(d), TIMEOUT_MS);
      }, DELAY_MIN + Math.random() * DELAY_RANGE);
    }, READY_MS);
  }

  function resolve(d) {
    if (d.phase === 'done') return;
    clearTimers(d);
    d.phase = 'done';
    const [a, b] = d.players;
    let win = -1, reason = 'timeout';
    if (a.foul || b.foul) {
      reason = 'foul';
      win = (a.foul && b.foul) ? -1 : (a.foul ? 1 : 0);
    } else if (a.adj !== null && b.adj !== null) {
      reason = 'fast';
      win = a.adj < b.adj ? 0 : (b.adj < a.adj ? 1 : -1);
    } else if (a.adj !== null || b.adj !== null) {
      reason = 'fast';
      win = a.adj !== null ? 0 : 1;
    }
    if (win >= 0) d.score[win]++;
    d.players.forEach((p, i) => {
      const opp = d.players[1 - i];
      send(p, {
        t: 'd_result', reason,
        winner: win < 0 ? 'none' : (win === i ? 'you' : 'opp'),
        you: p.adj, opp: opp.adj, youFoul: p.foul, oppFoul: opp.foul,
        score: [d.score[i], d.score[1 - i]],
      });
    });
    if (d.score[0] >= WIN_SCORE || d.score[1] >= WIN_SCORE) {
      later(d, () => {
        d.phase = 'over';
        const w = d.score[0] > d.score[1] ? 0 : 1;
        d.players.forEach((p, i) => send(p, { t: 'd_over', winner: w === i ? 'you' : 'opp', score: [d.score[i], d.score[1 - i]] }));
      }, 2200);
    } else {
      later(d, () => nextRound(d), NEXT_ROUND_MS);
    }
  }

  function tap(d, p) {
    if (p.tapAt) return;
    const now = Date.now();
    if (d.phase === 'ready' || d.phase === 'wait') { // too early
      p.tapAt = now; p.foul = true;
      return resolve(d);
    }
    if (d.phase !== 'draw') return;
    p.tapAt = now;
    // compensate for network latency: half of the measured round trip
    p.adj = Math.max(0, Math.round(now - d.drawAt - p.rtt / 2));
    if (d.players.every((x) => x.adj !== null)) return resolve(d);
    later(d, () => resolve(d), GRACE_MS);
  }

  function leave(p) {
    const d = p.duel;
    if (!d) return;
    clearTimeout(p.pingT);
    clearInterval(p.pingI);
    clearTimers(d);
    d.players = d.players.filter((x) => x !== p);
    if (queueCode === d.code && d.players.length === 0) queueCode = null;
    if (d.players.length === 0) { duels.delete(d.code); return; }
    const other = d.players[0];
    d.phase = 'idle'; d.score = [0, 0]; d.rematch.clear();
    send(other, { t: 'd_opp_left' });
    if (!queueCode && d.code.startsWith('Q')) queueCode = d.code;
  }

  wss.on('connection', (ws) => {
    const p = { ws, name: '', duel: null, rtt: 100, tapAt: 0, adj: null, foul: false };

    ws.on('pong', () => {
      if (!p.pingSent) return;
      const r = Date.now() - p.pingSent;
      p.rtt = p.gotRtt ? Math.round(p.rtt * 0.6 + r * 0.4) : r;
      p.gotRtt = true;
    });

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m.t !== 'string' || m.t.slice(0, 2) !== 'd_') return;

      if (m.t === 'd_join' && !p.duel) {
        p.name = clean(m.name, 14) || 'Каубой';
        let code = clean(m.room, 6).toUpperCase().replace(/[^A-Z0-9]/g, '');
        let d;
        if (!code) { // random opponent
          if (queueCode && duels.get(queueCode) && duels.get(queueCode).players.length === 1) {
            d = duels.get(queueCode); queueCode = null;
          } else {
            code = 'Q' + Math.random().toString(36).slice(2, 6).toUpperCase();
            d = newDuel(code); queueCode = code;
          }
        } else {
          d = duels.get(code) || newDuel(code);
          if (d.players.length >= 2) { send(p, { t: 'd_error', msg: 'Стаята е пълна' }); return; }
        }
        p.duel = d;
        d.players.push(p);
        p.pingI = setInterval(() => { p.pingSent = Date.now(); if (ws.readyState === 1) ws.ping(); }, 1500);
        p.pingSent = Date.now(); if (ws.readyState === 1) ws.ping();
        if (d.players.length === 1) send(p, { t: 'd_wait', room: d.code.startsWith('Q') ? '' : d.code });
        else setTimeout(() => { if (d.players.length === 2 && d.phase === 'idle') startMatch(d); }, 700);
        return;
      }
      if (!p.duel) return;
      if (m.t === 'd_tap') tap(p.duel, p);
      else if (m.t === 'd_rematch' && p.duel.phase === 'over') {
        p.duel.rematch.add(p);
        if (p.duel.rematch.size === 2) startMatch(p.duel);
      }
    });

    ws.on('close', () => leave(p));
  });
};
