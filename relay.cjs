// Carbox live relay: the iPhone app reads the car over Bluetooth and uploads the readings here;
// browsers (CarTV, Safari, anything) watch them. iPhone browsers can't use Bluetooth, so this is the bridge.
//   WS   /ingest?key=KEY   the Carbox app uploads {"push":{...}} / {"reply":{...}} text frames (~20/s)
//   GET  /live?key=KEY     Server-Sent Events: the same frames, forwarded as they arrive
//   POST /cmd?key=KEY      a button press in the browser, forwarded to the app (pause, pick adapter, ...)
//   GET  /status?key=KEY   {"uplink":true,"ageMs":123,"viewers":1}
//   everything else        the dash itself (static files)
// CARBOX_KEY (env) is the shared secret. Without it, no live endpoint works. The data includes GPS, so
// treat the key like a password.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8788, KEY = process.env.CARBOX_KEY || '';
const ROOT = __dirname, MAX_VIEWERS = 25, MAX_FRAME = 64 * 1024;
const PUBLIC = new Set(['index.html', 'style.css', 'js', 'fonts', 'icons', 'data']);   // never serve ios/, tests/, .git ...
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.dbc': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const KEY_HASH = digest(KEY);
const keyOk = (url) => !!KEY && crypto.timingSafeEqual(digest(url.searchParams.get('key') || ''), KEY_HASH);

const viewers = new Set();
let uplink = null, lastPush = '', lastAt = 0;

function fanOut(text) {
  const chunk = `data: ${text}\n\n`;
  for (const r of viewers) r.write(chunk);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
wss.on('connection', (ws) => {
  if (uplink && uplink !== ws) uplink.close(1000, 'replaced');   // one phone at a time: the newest wins
  uplink = ws; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString();
    if (text.includes('\n') || text[0] !== '{') return;
    lastAt = Date.now();
    if (text.startsWith('{"push"')) lastPush = text;
    fanOut(text);
  });
  ws.on('close', () => { if (uplink === ws) uplink = null; });
  ws.on('error', () => {});
});
setInterval(() => {   // drop a phone that went out of coverage without closing
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
  for (const r of viewers) r.write(': ping\n\n');
}, 15000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const deny = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end(msg); };

  if (url.pathname === '/healthz') return deny(200, 'ok');   // Render health check: no data, no key

  if (req.method === 'GET' && url.pathname === '/live') {
    if (!keyOk(url)) return deny(403, 'bad key');
    if (viewers.size >= MAX_VIEWERS) return deny(503, 'too many viewers');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': carbox\n\n');
    if (lastPush && Date.now() - lastAt < 5000) res.write(`data: ${lastPush}\n\n`);
    viewers.add(res); req.on('close', () => viewers.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/cmd') {
    if (!keyOk(url)) return deny(403, 'bad key');
    let body = '', big = false;
    req.on('data', (c) => { body += c; if (body.length > 4096) { big = true; req.destroy(); } });
    req.on('end', () => {
      if (big) return;
      let m; try { m = JSON.parse(body); } catch { return deny(400, 'bad json'); }
      if (!m || typeof m.cmd !== 'string') return deny(400, 'no cmd');
      if (!uplink || uplink.readyState !== 1) return deny(503, 'app offline');
      uplink.send(JSON.stringify(m)); res.writeHead(204); res.end();
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    if (!keyOk(url)) return deny(403, 'bad key');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ uplink: !!uplink, ageMs: lastAt ? Date.now() - lastAt : null, viewers: viewers.size }));
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
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ingest' || !keyOk(url)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
server.listen(PORT, () => console.log(`carbox relay on :${PORT}${KEY ? '' : '  (CARBOX_KEY not set: live endpoints are locked)'}`));
