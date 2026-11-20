// Round mode: 60s, pistol sound, timer (top-left), end report
(function () {
    'use strict';
    const ROUND_MS = 60000;
    let state = 'idle', endAt = 0, shots = 0, lastSec = -1, fragsStart = 0;
    let ac = null;

    function ctxA() {
          if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
          if (ac.state === 'suspended') ac.resume();
          return ac;
        }
    function noiseBuf(a, dur) {
          const n = Math.floor(a.sampleRate * dur), b = a.createBuffer(1, n, a.sampleRate), d = b.getChannelData(0);
          for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
          return b;
        }
    function gunshot() {
          const a = ctxA(); if (!a) return;
          const t = a.currentTime;
          const master = a.createGain(); master.gain.value = 0.9; master.connect(a.destination);
          const n1 = a.createBufferSource(); n1.buffer = noiseBuf(a, 0.18);
          const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
          const g1 = a.createGain(); g1.gain.setValueAtTime(1, t); g1.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
          n1.connect(hp); hp.connect(g1); g1.connect(master); n1.start(t);
          const o = a.createOscillator(); o.type = 'sine';
          o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
          const g2 = a.createGain(); g2.gain.setValueAtTime(0.9, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
          o.connect(g2); g2.connect(master); o.start(t); o.stop(t + 0.16);
          const n2 = a.createBufferSource(); n2.buffer = noiseBuf(a, 0.5);
          const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200;
          const g3 = a.createGain(); g3.gain.setValueAtTime(0.25, t + 0.03); g3.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
          n2.connect(lp); lp.connect(g3); g3.connect(master); n2.start(t + 0.03);
        }
    function tone(f, dur, vol, type) {
          const a = ctxA(); if (!a) return;
          const t = a.currentTime, o = a.createOscillator(), g = a.createGain();
          o.type = type || 'sine'; o.frequency.value = f;
          g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
        }

    beep = function (freq, dur, type) {
          if (type === 'sawtooth') { gunshot(); if (navigator.vibrate) navigator.vibrate(25); }
          else tone(freq, dur, 0.05, 'triangle');
        };

    const origFire = fire;
    fire = function () {
          if (state !== 'running') return;
          const before = lastShotAt;
          origFire();
          if (lastShotAt !== before) shots++;
        };

    const css = document.createElement('style');
    css.textContent =
      '#timer{top:max(10px,env(safe-area-inset-top));left:10px;font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:1px;display:none;min-width:92px;text-align:center}' +
      '#timer.urgent{background:rgba(190,0,0,.85);animation:tp .5s infinite alternate}' +
      '@keyframes tp{from{transform:scale(1)}to{transform:scale(1.15)}}' +
      '#feed{top:calc(max(10px,env(safe-area-inset-top)) + 58px) !important}' +
      '#urg{position:fixed;inset:0;pointer-events:none;display:none;box-shadow:inset 0 0 90px 20px rgba(255,0,0,.55);animation:up .5s infinite alternate}' +
      '@keyframes up{from{opacity:.25}to{opacity:1}}' +
      '#report{position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;background:rgba(5,10,20,.92);padding:20px}' +
      '#report .box{width:100%;max-width:340px;text-align:center}' +
      '#report h2{margin:0 0 14px;font-size:30px;letter-spacing:2px}' +
      '#report .big{font-size:64px;font-weight:800;color:#ffd23b;line-height:1;margin:6px 0 16px}' +
      '#report .row{display:flex;justify-content:space-between;padding:8px 4px;border-bottom:1px solid #345;font-size:16px}' +
      '#report button{width:100%;margin-top:18px;padding:16px;border-radius:10px;border:0;background:#ff2d55;color:#fff;font-size:18px;font-weight:700}';
    document.head.appendChild(css);

    const timer = document.createElement('div'); timer.id = 'timer'; timer.className = 'panel'; timer.textContent = '1:00';
    const urg = document.createElement('div'); urg.id = 'urg';
    const report = document.createElement('div'); report.id = 'report';
    document.body.appendChild(timer); document.body.appendChild(urg); document.body.appendChild(report);

    document.title = 'Лов на мишени';
    const h1 = document.querySelector('#lobby h1'); if (h1) h1.textContent = 'ЛОВ НА МИШЕНИ';
    const lp = document.querySelector('#lobby p'); if (lp) lp.textContent = 'Имаш точно 1 минута. Стреляй мишени и други играчи през камерата на телефона.';

    function startRound() {
          state = 'running'; shots = 0; targetsHit = 0; lastSec = -1;
          endAt = performance.now() + ROUND_MS;
          fragsStart = (typeof me !== 'undefined' && me) ? me.score : 0;
          timer.style.display = 'block'; timer.classList.remove('urgent');
          urg.style.display = 'none'; report.style.display = 'none';
          try { updateHud(); } catch (e) {}
        }

    function endRound() {
          state = 'over';
          timer.textContent = '0:00'; timer.classList.remove('urgent'); urg.style.display = 'none';
          tone(660, 0.15, 0.1, 'square');
          setTimeout(function () { tone(440, 0.15, 0.1, 'square'); }, 160);
          setTimeout(function () { tone(330, 0.4, 0.1, 'square'); }, 320);
          if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
          const acc = shots ? Math.round(targetsHit / shots * 100) : 0;
          const frags = (typeof me !== 'undefined' && me) ? Math.max(0, me.score - fragsStart) : 0;
          report.innerHTML =
            '<div class="box"><h2>КРАЙ НА ИГРАТА</h2><div>Застреляни мишени</div><div class="big">' + targetsHit + '</div>' +
            '<div class="row"><span>Изстрели</span><b>' + shots + '</b></div>' +
            '<div class="row"><span>Точност по мишени</span><b>' + acc + '%</b></div>' +
            '<div class="row"><span>Елиминирани играчи</span><b>' + frags + '</b></div>' +
            '<button id="again">ИГРАЙ ПАК</button></div>';
          report.style.display = 'flex';
          document.getElementById('again').addEventListener('click', startRound);
        }

    function tick() {
          if (state === 'idle' && document.getElementById('lobby').style.display === 'none') startRound();
          if (state !== 'running') return;
          const rem = Math.max(0, endAt - performance.now()), sec = Math.ceil(rem / 1000);
          timer.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
          if (sec !== lastSec) {
                  lastSec = sec;
                  if (sec > 5) tone(1200, 0.03, 0.012);
                  else if (sec > 0) {
                            tone(880 + (5 - sec) * 140, 0.12, 0.09, 'square');
                            if (navigator.vibrate) navigator.vibrate(40);
                          }
                }
          if (sec <= 5 && sec > 0) { timer.classList.add('urgent'); urg.style.display = 'block'; }
          if (rem <= 0) endRound();
        }
    setInterval(tick, 100);
  })();
