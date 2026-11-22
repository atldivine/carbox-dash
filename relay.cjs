// Carbox live relay: the iPhone app reads the car over Bluetooth and uploads the readings here;
// browsers (CarTV, Safari, anything) watch them. iPhone browsers can't use Bluetooth, so this is the bridge.
//
// Pairing (no keys to copy):
//   POST /pair/new             the website asks for a code -> {code:"482917", poll:SECRET, expiresIn:600}
//   POST /pair/claim           the app sends {"code":"482917"} -> {key:KEY} (codes are single-use, 10 min,
//                              rate-limited); the app then uploads with KEY
//   GET  /pair/wait?poll=...   the website checks every 2 s -> {paired:false} | {paired:true,key:KEY}
// Live:
//   WS   /ingest?key=KEY       the Carbox app uploads {"push":{...}} / {"reply":{...}} text frames (~20/s)
//   GET  /live?key=KEY         Server-Sent Events: the same frames, forwarded as they arrive
//   POST /cmd?key=KEY          a button press in the browser, forwarded to the app (pause, pick adapter, ...)
//   GET  /status?key=KEY       {"uplink":true,"ageMs":123,"viewers":1}
//   everything else            the dash itself (static files)
// Keys: CARBOX_KEY (env) is the master secret and still works as a key. Each pairing gets its own key
// "p.<id>.<sig>" signed with CARBOX_KEY, so it survives restarts (Render's free plan sleeps) without any
// storage, and pairings never see each other's data. Changing CARBOX_KEY revokes every pairing.
// The data includes GPS, so a key is a password.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { NissanClient } = require('./nissanClient.cjs');

const PORT = +process.env.PORT || 8788, KEY = process.env.CARBOX_KEY || '';
const ROOT = __dirname, MAX_VIEWERS = 25, MAX_FRAME = 256 * 1024, MAX_CHANNELS = 500;
const CODE_TTL = 10 * 60 * 1000, MAX_PENDING = 200;
const PUBLIC = new Set(['index.html', 'style.css', 'js', 'fonts', 'icons', 'data']);   // never serve ios/, tests/, .git ...
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.dbc': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

// ---- keys
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sign = (id) => crypto.createHmac('sha256', KEY).update('pair:' + id).digest('base64url').slice(0, 32);
const makeKey = (id) => `p.${id}.${sign(id)}`;
const same = (a, b) => { const x = digest(a), y = digest(b); return crypto.timingSafeEqual(x, y); };
/** Channel id for a key, or null. The master key is channel "master". */
function channelOf(key) {
  if (!KEY || !key) return null;
  if (same(key, KEY)) return 'master';
  const m = /^p\.([0-9a-f]{24})\.([A-Za-z0-9_-]{32})$/.exec(key);
  return m && same(m[2], sign(m[1])) ? m[1] : null;
}
const keyOf = (url) => channelOf(url.searchParams.get('key') || '');

// ---- channels: one phone uplink + its viewers per key
const channels = new Map();
function channel(id) {
  let c = channels.get(id);
  if (!c) {
    if (channels.size >= MAX_CHANNELS) for (const [k, v] of channels) if (!v.uplink && !v.viewers.size) { channels.delete(k); if (channels.size < MAX_CHANNELS) break; }
    c = { uplink: null, viewers: new Set(), lastPush: '', lastAt: 0 }; channels.set(id, c);
  }
  return c;
}
function fanOut(c, text) { const chunk = `data: ${text}\n\n`; for (const r of c.viewers) r.write(chunk); }

// ---- pairing codes (memory only: a code lives 10 minutes)
const pending = new Map();   // code -> { id, poll, expires, claimed }
const byPoll = new Map();    // poll secret -> code
const hits = new Map();      // "kind|ip" -> [timestamps]
function limited(kind, ip, max, windowMs) {
  const k = kind + '|' + ip, now = Date.now(), list = (hits.get(k) || []).filter((t) => now - t < windowMs);
  list.push(now); hits.set(k, list);
  return list.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [code, p] of pending) if (now > p.expires + 60000) { pending.delete(code); byPoll.delete(p.poll); }
  for (const [k, list] of hits) if (!list.some((t) => now - t < 600000)) hits.delete(k);
}, 60000).unref();
function newCode() {
  for (let i = 0; i < 20; i++) { const c = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); if (!pending.has(c)) return c; }
  return null;
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ---- MyNISSAN (cloud, not Bluetooth): door lock/unlock, fuel, mileage, warning lights for the user's own Z.
// Off entirely unless NISSAN_EMAIL/NISSAN_PASSWORD are set on the server. Gated behind the same pairing
// key as everything else above, since this data (and the lock/unlock commands) is just as sensitive.
const NISSAN_EMAIL = process.env.NISSAN_EMAIL || '', NISSAN_PASSWORD = process.env.NISSAN_PASSWORD || '';
const NISSAN_POLL_MS = 2 * 60 * 1000;
const nissan = NISSAN_EMAIL && NISSAN_PASSWORD
  ? new NissanClient({ tokenPath: path.join(ROOT, 'nissan-tokens.json') })
  : null;
let nissanVin = null, nissanStatus = null, nissanError = null;
async function nissanEnsureReady() {
  if (!nissan.tokens) await nissan.authenticate(NISSAN_EMAIL, NISSAN_PASSWORD);
  if (!nissanVin) {
    const vehicles = await nissan.getVehicles();
    if (!vehicles.length) throw new Error('no vehicles on this MyNISSAN account');
    nissanVin = vehicles[0].vin;
  }
}
async function nissanRefresh() {
  try { await nissanEnsureReady(); nissanStatus = await nissan.getVehicleStatus(nissanVin); nissanError = null; }
  catch (e) { nissanError = e.message; }
}
if (nissan) { nissanRefresh(); setInterval(nissanRefresh, NISSAN_POLL_MS).unref(); }

// ---- websocket uplink from the phone
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
wss.on('connection', (ws, req, id) => {
  const c = channel(id);
  if (c.uplink && c.uplink !== ws) c.uplink.close(1000, 'replaced');   // one phone per key: the newest wins
  c.uplink = ws; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString();
    if (text.includes('\n') || text[0] !== '{') return;
    c.lastAt = Date.now();
    if (text.startsWith('{"push"')) c.lastPush = text;
    fanOut(c, text);
  });
  ws.on('close', () => { if (c.uplink === ws) c.uplink = null; });
  ws.on('error', () => {});
});
setInterval(() => {   // drop a phone that went out of coverage without closing; keep viewer streams open
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  for (const c of channels.values()) for (const r of c.viewers) r.write(': ping\n\n');
}, 15000).unref();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(obj)); };
  const deny = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(msg); };
  const readBody = (cb) => {
    let body = '', big = false;
    req.on('data', (d) => { body += d; if (body.length > 4096) { big = true; req.destroy(); } });
    req.on('end', () => { if (!big) cb(body); });
  };

  if (url.pathname === '/healthz') return deny(200, 'ok');   // Render health check: no data, no key

  // ---- pairing
  if (url.pathname.startsWith('/pair/')) {
    // The app's page runs on its own origin (carbox://), so the claim endpoint answers cross-origin.
    // It's a plain-text POST (no preflight); the code itself is the secret.
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (!KEY) return send(503, { error: 'pairing is off: CARBOX_KEY is not set on the server' }, cors);
    const ip = clientIp(req);
    if (req.method === 'POST' && url.pathname === '/pair/new') {
      if (limited('new', ip, 30, 600000) || pending.size >= MAX_PENDING) return send(429, { error: 'too many codes, wait a minute' });
      const code = newCode(); if (!code) return send(503, { error: 'busy' });
      const id = crypto.randomBytes(12).toString('hex'), poll = crypto.randomBytes(18).toString('base64url');
      pending.set(code, { id, poll, expires: Date.now() + CODE_TTL, claimed: false }); byPoll.set(poll, code);
      return send(200, { code, poll, expiresIn: CODE_TTL / 1000 });
    }
    if (req.method === 'GET' && url.pathname === '/pair/wait') {
      const code = byPoll.get(url.searchParams.get('poll') || ''), p = code && pending.get(code);
      if (!p) return send(404, { error: 'unknown or expired' });
      if (p.claimed) { pending.delete(code); byPoll.delete(p.poll); return send(200, { paired: true, key: makeKey(p.id) }); }
      if (Date.now() > p.expires) return send(410, { error: 'expired' });
      return send(200, { paired: false, expiresIn: Math.round((p.expires - Date.now()) / 1000) });
    }
    if (req.method === 'POST' && url.pathname === '/pair/claim') {
      // 20 tries per 10 minutes per address, and 300 failed tries per 10 minutes overall: a 6-digit code
      // can't be guessed in its 10-minute life.
      if (limited('claim', ip, 20, 600000)) return send(429, { error: 'too many tries, wait a few minutes' }, cors);
      return readBody((body) => {
        let code = ''; try { code = String(JSON.parse(body).code || ''); } catch { code = body; }
        code = code.replace(/\D/g, '');
        const p = pending.get(code);
        if (!p || p.claimed || Date.now() > p.expires) {
          if (limited('fail', 'all', 300, 600000)) return send(429, { error: 'too many tries, wait a few minutes' }, cors);
          return send(404, { error: 'that code is wrong or has expired' }, cors);
        }
        p.claimed = true;
        return send(200, { key: makeKey(p.id) }, cors);
      });
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Max-Age': '600' }); return res.end(); }
    return deny(404, 'not found');
  }

  if (req.method === 'GET' && url.pathname === '/live') {
    const id = keyOf(url); if (!id) return deny(403, 'bad key');
    const c = channel(id);
    if (c.viewers.size >= MAX_VIEWERS) return deny(503, 'too many viewers');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': carbox\n\n');
    if (c.lastPush && Date.now() - c.lastAt < 5000) res.write(`data: ${c.lastPush}\n\n`);
    c.viewers.add(res); req.on('close', () => c.viewers.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/cmd') {
    const id = keyOf(url); if (!id) return deny(403, 'bad key');
    return readBody((body) => {
      let m; try { m = JSON.parse(body); } catch { return deny(400, 'bad json'); }
      if (!m || typeof m.cmd !== 'string') return deny(400, 'no cmd');
      const c = channels.get(id);
      if (!c || !c.uplink || c.uplink.readyState !== 1) return deny(503, 'app offline');
      c.uplink.send(JSON.stringify(m)); res.writeHead(204); res.end();
    });
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    const id = keyOf(url); if (!id) return deny(403, 'bad key');
    const c = channels.get(id);
    return send(200, { uplink: !!(c && c.uplink), ageMs: c && c.lastAt ? Date.now() - c.lastAt : null, viewers: c ? c.viewers.size : 0 });
  }

  if (url.pathname === '/nissan/status' && req.method === 'GET') {
    if (!keyOf(url)) return deny(403, 'bad key');
    if (!nissan) return send(503, { error: 'MyNISSAN is not configured on this server' });
    if (nissanError && !nissanStatus) return send(502, { connected: false, error: nissanError });
    return send(200, { connected: !nissanError, vin: nissanVin, status: nissanStatus, error: nissanError || undefined });
  }
  if (url.pathname === '/nissan/cmd' && req.method === 'POST') {
    if (!keyOf(url)) return deny(403, 'bad key');
    if (!nissan) return send(503, { error: 'MyNISSAN is not configured on this server' });
    return readBody(async (body) => {
      let m; try { m = JSON.parse(body); } catch { return deny(400, 'bad json'); }
      const cmd = m && m.cmd;
      if (!['lock', 'unlock', 'flash-lights'].includes(cmd)) return deny(400, 'cmd must be lock, unlock, or flash-lights');
      try {
        await nissanEnsureReady();
        const result = cmd === 'lock' ? await nissan.doorLock(nissanVin)
          : cmd === 'unlock' ? await nissan.doorUnlock(nissanVin)
          : await nissan.flashLights(nissanVin);
        nissanRefresh();   // pick up the new door/lock state in the background, don't block the response
        return send(200, { result: result || 'UNKNOWN_TIMED_OUT' });
      } catch (e) { return send(502, { error: e.message }); }
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'method not allowed');
  let p; try { p = decodeURIComponent(url.pathname); } catch { return deny(400, 'bad path'); }
  if (p.endsWith('/')) p += 'index.html';
  const rel = path.normalize(p).replace(/^[/\\]+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || !PUBLIC.has(rel.split(/[/\\]/)[0])) return deny(404, 'not found');
  fs.readFile(file, (err, data) => {
    if (err) return deny(404, 'not found');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x'), id = url.pathname === '/ingest' ? keyOf(url) : null;
  if (!id) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, id));
});
server.listen(PORT, () => console.log(`carbox relay on :${PORT}${KEY ? '' : '  (CARBOX_KEY not set: live endpoints and pairing are locked)'}`));
