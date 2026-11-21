// Bumper Royale authoritative multiplayer server.
// Run locally:  npm install && npm start   (PORT env var, default 3000)
// Also serves index.html at "/", so http://localhost:3000 is a complete one-click local setup.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const CX = 400, CY = 300, MAXP = 10, MAPS = 7, VERSION = '1.2.0';
const rooms = new Map();

// ---------- HTTP (game page + health check) ----------
const srv = http.createServer((q, r) => {
  const url = (q.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      if (e) { r.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); return r.end('Bumper Royale server OK, rooms: ' + rooms.size); }
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(d);
    });
    return;
  }
  r.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  r.end(JSON.stringify({ game: 'bumper-royale', ok: true, version: VERSION, rooms: rooms.size, players: wss.clients.size }));
});
const wss = new WebSocketServer({ server: srv, maxPayload: 4096 });

// ---------- helpers ----------
// 6 digits, numbers only, no repeated digits, never starts with 0
function code() {
  let c;
  do {
    const d = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    for (let i = d.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [d[i], d[j]] = [d[j], d[i]]; }
    if (d[0] === 0) { const k = 1 + (Math.random() * 9 | 0); [d[0], d[k]] = [d[k], d[0]]; }
    c = d.slice(0, 6).join('');
  } while (rooms.has(c));
  return c;
}
const send = (w, m) => { if (w.readyState === 1) w.send(JSON.stringify(m)); };
const all = (r, m) => r.pl.forEach(p => send(p.ws, m));
const cap = r => r.max || MAXP;
const info = r => ({ code: r.code, pub: r.pub, max: cap(r), host: r.host, set: r.set, run: r.run, pl: r.pl.map(p => ({ id: p.id, name: p.name, skin: p.skin, ready: p.ready })) });
const pubList = () => [...rooms.values()].filter(r => r.pub && !r.run && r.pl.length < cap(r)).map(r => ({ code: r.code, n: r.pl.length, max: cap(r), map: r.set.map, mod: r.set.mod }));
const clean = n => String(n || 'Player').replace(/[<>&"]/g, '').slice(0, 12) || 'Player';
const skinOf = s => Math.max(0, Math.min(999, s | 0));
const newRoom = (o) => {
  const rm = { code: code(), pub: !!o.pub, max: o.max, host: 0, pl: [], run: false, set: { map: o.map, pu: o.pu, mod: o.mod }, pu: [] };
  rooms.set(rm.code, rm); return rm;
};

function join(ws, r, name, skin) {
  if (r.run || r.pl.length >= cap(r)) return send(ws, { t: 'err', m: r.run ? 'Match already started' : 'Room full' });
  const p = { ws, id: ++join.n, name: clean(name), skin: skinOf(skin), ready: false, x: CX, y: CY, vx: 0, vy: 0, in: { x: 0, y: 0, d: 0 }, alive: true, dc: 0, pw: 0, pwT: 0, fz: 0, last: 0 };
  ws.p = p; ws.r = r; r.pl.push(p);
  if (!r.host) r.host = p.id;
  send(ws, { t: 'joined', me: p.id, room: info(r) });
  all(r, { t: 'room', room: info(r) });
}
join.n = 0;

function leave(ws) {
  const r = ws.r; if (!r) return;
  r.pl = r.pl.filter(p => p !== ws.p); ws.r = null;
  if (!r.pl.length) { clearInterval(r.iv); rooms.delete(r.code); return; }
  if (r.host === ws.p.id) r.host = r.pl[0].id;
  all(r, { t: 'room', room: info(r) });
  if (r.run) check(r);
}

function start(r) {
  r.run = true; r.R = 290; r.t = 0; r.pu = [];
  r.pl.forEach((p, i) => {
    const a = i / r.pl.length * Math.PI * 2;
    Object.assign(p, { x: CX + Math.cos(a) * 150, y: CY + Math.sin(a) * 150, vx: 0, vy: 0, alive: true, dc: 0, pw: 0, pwT: 0, fz: 0, last: 0, ready: false, in: { x: 0, y: 0, d: 0 } });
  });
  all(r, { t: 'start', room: info(r) });
  r.iv = setInterval(() => tick(r), 1000 / 60);
}

function check(r) {
  const a = r.pl.filter(p => p.alive);
  if (a.length <= 1 && r.pl.length > 0) {
    clearInterval(r.iv); r.run = false;
    all(r, { t: 'end', winner: a[0] ? a[0].id : 0 });
    r.pl.forEach(p => { p.ready = false; });
    all(r, { t: 'room', room: info(r) });
  }
}

// power-up kinds (k): 0 shield, 1 boost, 2 mega, 3 freeze.  Snapshot status: 1 shield, 2 boost, 3 mega, 4 frozen
const status = p => p.fz > 0 ? 4 : p.pw;

function tick(r) {
  r.t += 1 / 60;
  r.R = Math.max(70, 290 - r.t * 3);
  const fr = r.set.mod === 'slippery' ? .985 : .96;
  if (r.set.pu && Math.random() < .004 && r.pu.length < 4)
    r.pu.push({ id: Math.random() * 1e9 | 0, x: CX + (Math.random() - .5) * 300, y: CY + (Math.random() - .5) * 300, k: Math.random() * 4 | 0 });

  for (const p of r.pl) {
    if (!p.alive) continue;
    let { x, y } = p.in; const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    if (p.fz > 0) { p.fz--; x = 0; y = 0; }
    const sp = p.pw === 2 ? .55 : .34;
    p.vx += x * sp; p.vy += y * sp;
    if (p.in.d && p.dc <= 0 && p.fz <= 0) {
      const m = Math.hypot(p.vx, p.vy) || 1;
      p.vx += p.vx / m * 9; p.vy += p.vy / m * 9; p.dc = 90;
    }
    p.in.d = 0;                       // a dash press counts once
    if (p.dc > 0) p.dc--;
    p.vx *= fr; p.vy *= fr; p.x += p.vx; p.y += p.vy;

    for (const u of r.pu) {
      if (u.k < 0 || Math.hypot(u.x - p.x, u.y - p.y) >= 28) continue;
      if (u.k === 3) { for (const o of r.pl) if (o !== p && o.alive && o.pw !== 1 && Math.hypot(o.x - p.x, o.y - p.y) < 150) o.fz = 150; }
      else { p.pw = u.k + 1; p.pwT = u.k === 1 ? 240 : 300; }
      u.k = -1;
    }
    if (p.pwT > 0 && --p.pwT === 0) p.pw = 0;

    if (Math.hypot(p.x - CX, p.y - CY) > r.R + 16) { p.alive = false; all(r, { t: 'ko', id: p.id, by: p.last || 0 }); }
  }
  r.pu = r.pu.filter(u => u.k >= 0);

  for (let i = 0; i < r.pl.length; i++) for (let j = i + 1; j < r.pl.length; j++) {
    const a = r.pl[i], b = r.pl[j]; if (!a.alive || !b.alive) continue;
    let dx = b.x - a.x, dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1;
    const rad = (a.pw === 3 ? 22 : 16) + (b.pw === 3 ? 22 : 16);
    if (d >= rad) continue;
    dx /= d; dy /= d;
    const o = (rad - d) / 2; a.x -= dx * o; a.y -= dy * o; b.x += dx * o; b.y += dy * o;
    const rv = (b.vx - a.vx) * dx + (b.vy - a.vy) * dy;
    if (rv < 0) {
      const k = -rv * 1.6;
      const sa = (a.pw === 1 ? .3 : 1) / (a.pw === 3 ? 1.6 : 1), sb = (b.pw === 1 ? .3 : 1) / (b.pw === 3 ? 1.6 : 1);
      a.vx -= dx * k * sa; a.vy -= dy * k * sa; b.vx += dx * k * sb; b.vy += dy * k * sb;
      a.last = b.id; b.last = a.id;
    }
  }

  all(r, {
    t: 's', R: r.R,
    c: r.pl.map(p => [p.id, +p.x.toFixed(1), +p.y.toFixed(1), +p.vx.toFixed(2), +p.vy.toFixed(2), p.alive ? 1 : 0, status(p)]),
    pu: r.pu.map(u => [u.id, u.x | 0, u.y | 0, u.k])
  });
  check(r);
}

// ---------- WebSocket ----------
wss.on('connection', ws => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { t: 'hello', rooms: pubList() });
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const r = ws.r, p = ws.p;
    if (m.t === 'ping') send(ws, { t: 'pong', ts: m.ts, n: wss.clients.size });
    else if (m.t === 'list') send(ws, { t: 'rooms', rooms: pubList() });
    else if (m.t === 'leave') leave(ws);
    else if (m.t === 'quick' && !r) {
      const rm = [...rooms.values()].find(x => x.pub && !x.run && x.pl.length < cap(x));
      join(ws, rm || newRoom({ pub: true, max: MAXP, map: Math.random() * MAPS | 0, pu: true, mod: '' }), m.name, m.skin);
    }
    else if (m.t === 'create' && !r) {
      const max = Math.min(MAXP, Math.max(2, (m.max | 0) || MAXP));
      const map = ((m.map | 0) % MAPS + MAPS) % MAPS;
      join(ws, newRoom({ pub: !!m.pub, max, map, pu: m.pu !== 0 && m.pu !== false, mod: m.mod === 'slippery' ? 'slippery' : '' }), m.name, m.skin);
    }
    else if (m.t === 'join' && !r) {
      const rm = rooms.get(String(m.code || '').trim());
      rm ? join(ws, rm, m.name, m.skin) : send(ws, { t: 'err', m: 'Room not found' });
    }
    else if (r && m.t === 'set' && r.host === p.id && !r.run) {
      r.set.map = ((m.map | 0) % MAPS + MAPS) % MAPS; r.set.pu = !!m.pu; r.set.mod = m.mod === 'slippery' ? 'slippery' : '';
      if ('pub' in m) r.pub = !!m.pub;
      all(r, { t: 'room', room: info(r) });
    }
    else if (r && m.t === 'ready' && !r.run) { p.ready = !!m.v; all(r, { t: 'room', room: info(r) }); }
    else if (r && m.t === 'go' && r.host === p.id && !r.run) {
      if (r.pl.length > 1 && r.pl.every(q => q.id === r.host || q.ready)) start(r);
      else send(ws, { t: 'err', m: 'Need 2+ players and everyone ready' });
    }
    else if (r && m.t === 'in' && r.run) p.in = { x: +m.x || 0, y: +m.y || 0, d: m.d ? 1 : 0 };
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// drop dead connections (Render's proxy also closes idle sockets)
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} }), 30000);

srv.listen(PORT, () => console.log('Bumper Royale server v' + VERSION + ' on :' + PORT + '  (open http://localhost:' + PORT + ')'));
