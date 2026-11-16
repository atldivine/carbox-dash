// node tests/relay.test.mjs : starts relay.cjs and checks upload -> viewer, commands back, auth and static whitelist.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const PORT = 18788, KEY = 'test-key-123', base = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, ['relay.cjs'], { env: { ...process.env, PORT: String(PORT), CARBOX_KEY: KEY }, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code) => { srv.kill(); process.exit(code); };
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { await sleep(100); } }
  // auth
  assert.equal((await fetch(`${base}/live`)).status, 403);
  assert.equal((await fetch(`${base}/live?key=nope`)).status, 403);
  assert.equal((await fetch(`${base}/status?key=nope`)).status, 403);
  assert.equal((await fetch(`${base}/cmd?key=nope`, { method: 'POST', body: '{"cmd":"pause"}' })).status, 403);
  // static whitelist
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/js/main.js`)).status, 200);
  for (const p of ['/ios/project.yml', '/relay.cjs', '/package.json', '/.git/config', '/tests/relay.test.mjs', '/%2e%2e/etc/passwd', '/js/../relay.cjs'])
    assert.equal((await fetch(base + p)).status, 404, p);
  // no uplink yet
  assert.equal((await fetch(`${base}/cmd?key=${KEY}`, { method: 'POST', body: '{"cmd":"pause"}' })).status, 503);
  // uplink + viewer
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ingest?key=${KEY}`);
  const fromViewer = []; ws.onmessage = (e) => fromViewer.push(JSON.parse(e.data));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ingest?key=wrong`);
  await new Promise((r) => { bad.onerror = r; bad.onclose = r; });
  const res = await fetch(`${base}/live?key=${KEY}`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
  const t0 = performance.now(); ws.send(JSON.stringify({ push: { v: { rpm: 3456 } } }));
  while (!buf.includes('3456')) { const { value } = await reader.read(); buf += dec.decode(value); }
  console.log(`uplink -> viewer in ${(performance.now() - t0).toFixed(1)} ms`);
  ws.send('not json\nsecond line'); ws.send(JSON.stringify({ reply: { id: 1, text: 'ok', error: '' } }));
  while (!buf.includes('"reply"')) { const { value } = await reader.read(); buf += dec.decode(value); }
  assert.ok(!buf.includes('not json'));
  // command back to the app
  assert.equal((await fetch(`${base}/cmd?key=${KEY}`, { method: 'POST', body: '{"cmd":"pause"}' })).status, 204);
  assert.equal((await fetch(`${base}/cmd?key=${KEY}`, { method: 'POST', body: 'x' })).status, 400);
  await sleep(100); assert.deepEqual(fromViewer, [{ cmd: 'pause' }]);
  const st = await (await fetch(`${base}/status?key=${KEY}`)).json(); assert.equal(st.uplink, true); assert.equal(st.viewers, 1);
  // a late viewer gets the latest frame immediately
  const late = await fetch(`${base}/live?key=${KEY}`); const lr = late.body.getReader(); let lb = '';
  while (!lb.includes('3456')) { const { value } = await lr.read(); lb += dec.decode(value); }
  ws.close(); await sleep(100);
  assert.equal((await (await fetch(`${base}/status?key=${KEY}`)).json()).uplink, false);
  console.log('relay tests passed'); done(0);
} catch (e) { console.error(e); done(1); }
