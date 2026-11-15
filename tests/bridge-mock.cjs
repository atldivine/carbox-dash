// node tests/bridge-mock.cjs  -> http://localhost:8787
// Stands in for the iPhone app's BridgeServer.swift so the browser side (CarTV / Safari) can be tested
// on a PC: serves the dash, streams fake live OBD data on /live (Server-Sent Events, same payload shape),
// and accepts /cmd only with the X-Carbox header, like the real one.
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), PORT = 8787;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf', '.dbc': 'text/plain' };
const streams = new Set(), commands = [];
let t0 = Date.now(), paused = false;

function payload() {
  const t = (Date.now() - t0) / 1000, cyc = t % 20, pull = cyc > 4 && cyc < 14;
  const mph = pull ? (cyc - 4) * 9 : Math.max(0, 90 - (cyc - 14) * 15) * (cyc >= 14 ? 1 : 0);
  const gear = mph < 1 ? 0 : Math.min(6, 1 + Math.floor(mph / 18));
  const ratios = [3.794, 2.324, 1.624, 1.271, 1.0, 0.794];
  const rpm = gear ? Math.max(1200, mph / 2.23694 / 2.121 * 60 * ratios[gear - 1] * 3.538) : 720 + Math.sin(t * 3) * 10;
  return { v: { rpm, speed: mph, boost: pull ? 12 : -10.5, throttle: pull ? 100 : 11, coolant: 192, iat: 88, battery: 14.3, timing: pull ? 12 : 4,
    torque_pct: pull ? 92 : 4, torque_ref: 475 }, source: 'obd', status: paused ? 'PAUSED' : 'OBD', paused, error: '',
    adapter: { name: 'Mock adapter', elm: 'ELM327 v1.5', fast: 'mock bridge' }, scanning: false };
}
setInterval(() => { const msg = `data: ${JSON.stringify({ push: payload() })}\n\n`; for (const r of streams) r.write(msg); }, 50);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/live') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': carbox\n\n'); streams.add(res); req.on('close', () => streams.delete(res)); return;
  }
  if (req.method === 'POST' && url.pathname === '/cmd') {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
      if (req.headers['x-carbox'] !== '1') { res.writeHead(403); res.end('forbidden'); return; }
      const m = JSON.parse(body); commands.push(m); if (m.cmd === 'pause') paused = !paused;
      if (m.cmd === 'obd') for (const r of streams) r.write(`data: ${JSON.stringify({ reply: { id: m.id, text: m.req === '03' ? '43 01 01 71' : 'NO DATA', error: '' } })}\n\n`);
      res.writeHead(204); res.end();
    }); return;
  }
  if (url.pathname === '/__commands') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(commands)); return; }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`mock bridge on http://localhost:${PORT}`));
