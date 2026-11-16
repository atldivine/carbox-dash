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
  // ---- pairing: the website gets a code, the app claims it, both end up on the same private channel
  const nw = await (await fetch(`${base}/pair/new`, { method: 'POST' })).json();
  assert.match(nw.code, /^\d{6}$/); assert.ok(nw.poll.length > 20);
  assert.deepEqual(await (await fetch(`${base}/pair/wait?poll=${nw.poll}`)).json(), { paired: false, expiresIn: 600 });
  const wrong = await fetch(`${base}/pair/claim`, { method: 'POST', body: JSON.stringify({ code: nw.code === '000000' ? '111111' : '000000' }) });
  assert.equal(wrong.status, 404); assert.equal(wrong.headers.get('access-control-allow-origin'), '*');
  const claim = await fetch(`${base}/pair/claim`, { method: 'POST', body: JSON.stringify({ code: nw.code.slice(0, 3) + ' ' + nw.code.slice(3) }) });   // spaces are fine
  assert.equal(claim.status, 200); const { key: appKey } = await claim.json(); assert.match(appKey, /^p\.[0-9a-f]{24}\./);
  assert.equal((await fetch(`${base}/pair/claim`, { method: 'POST', body: JSON.stringify({ code: nw.code }) })).status, 404, 'single use');
  const got = await (await fetch(`${base}/pair/wait?poll=${nw.poll}`)).json();
  assert.deepEqual(got, { paired: true, key: appKey });
  assert.equal((await fetch(`${base}/pair/wait?poll=${nw.poll}`)).status, 404, 'handed over once');
  // the paired key works for upload + viewing, and its channel is separate from the master one
  const pws = new WebSocket(`ws://127.0.0.1:${PORT}/ingest?key=${appKey}`);
  await new Promise((r, j) => { pws.onopen = r; pws.onerror = j; });
  const pv = await fetch(`${base}/live?key=${appKey}`), pr = pv.body.getReader(); let pb = '';
  pws.send(JSON.stringify({ push: { v: { rpm: 4321 } } }));
  while (!pb.includes('4321')) { const { value } = await pr.read(); pb += dec.decode(value); }
  assert.ok(!pb.includes('3456'), 'no data from the master channel');
  assert.equal((await fetch(`${base}/live?key=p.${'0'.repeat(24)}.${'A'.repeat(32)}`)).status, 403, 'forged pair key refused');
  pws.close();
  // brute force: the 21st claim from one address in 10 minutes is refused
  let last = 0; for (let i = 0; i < 21; i++) last = (await fetch(`${base}/pair/claim`, { method: 'POST', body: '{"code":"123456"}' })).status;
  assert.equal(last, 429);
  console.log('pairing ok: code -> app key -> website key, single use, separate channel, rate-limited');
  console.log('relay tests passed'); done(0);
} catch (e) { console.error(e); done(1); }
