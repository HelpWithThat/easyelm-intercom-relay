// Verify /v1/live + reconnect.
// RELAY=https://host APP_TOKEN=... node test-live-presence.js
const WebSocket = require('ws');
const baseHttp = (process.env.RELAY || 'http://localhost:10000').replace(/\/$/, '')
  .replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const baseWs = baseHttp.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
const token = process.env.APP_TOKEN;
if (!token) { console.error('APP_TOKEN required'); process.exit(1); }

const room = String(100000 + Math.floor(Math.random() * 899999));
const joeId = String(-(400000000000 + Math.floor(Math.random() * 1e8)));
const uncleId = String(9000000000 + Math.floor(Math.random() * 1e8));

async function live(peer) {
  const r = await fetch(`${baseHttp}/v1/live?peer=${encodeURIComponent(peer)}`, {
    headers: { 'x-app-token': token },
  });
  return r.json();
}

function open(peer) {
  return new Promise((ok, bad) => {
    const extra = peer ? `&peer=${encodeURIComponent(peer)}` : '';
    const w = new WebSocket(`${baseWs}/ws?room=${room}&token=${encodeURIComponent(token)}${extra}`);
    w.on('open', () => ok(w));
    w.on('error', bad);
    w.on('unexpected-response', (q, res) => bad(new Error('HTTP ' + res.statusCode)));
  });
}

function closed(w) {
  return new Promise((ok) => {
    if (w.readyState === WebSocket.CLOSED) return ok();
    w.once('close', () => ok());
    try { w.send('leave'); } catch (_) {}
    try { w.close(1000, 'bye'); } catch (_) {}
    setTimeout(() => { try { w.terminate(); } catch (_) {} ok(); }, 2000);
  });
}

function frameFrom(fromIdStr) {
  const buf = Buffer.alloc(40);
  buf[0] = 0x45; buf[1] = 0x49; buf[2] = 1; buf[3] = 2;
  buf.writeBigInt64BE(BigInt(fromIdStr), 4);
  buf.fill(0xcd, 17);
  return buf;
}

(async () => {
  await fetch(baseHttp + '/health');
  let uncle = await open(uncleId);
  let joe = await open(joeId);

  let a = await live(uncleId);
  if (!a.live || a.room !== room) throw new Error('uncle should be live in room: ' + JSON.stringify(a));

  let joeGot = false;
  joe.on('message', () => { joeGot = true; });
  uncle.send(frameFrom(uncleId));
  await new Promise(r => setTimeout(r, 400));
  if (!joeGot) throw new Error('joe did not hear uncle');

  await closed(uncle);
  let b = null;
  for (let i = 0; i < 30; i++) {
    b = await live(uncleId);
    if (!b.live) break;
    await new Promise(r => setTimeout(r, 100));
  }
  if (b.live) throw new Error('uncle should be offline after close: ' + JSON.stringify(b));

  uncle = await open(uncleId);
  await new Promise(r => setTimeout(r, 200));
  let c = await live(uncleId);
  if (!c.live) throw new Error('uncle should be live after reconnect');

  let uncleGot = false;
  uncle.on('message', (d) => {
    const buf = Buffer.from(d);
    if (buf.length >= 12 && buf.readBigInt64BE(4).toString() === joeId) uncleGot = true;
  });
  joe.send(frameFrom(joeId));
  await new Promise(r => setTimeout(r, 500));
  if (!uncleGot) throw new Error('uncle did not get joe audio after reconnect');

  const old = await open('');
  await closed(old);
  await closed(joe);
  await closed(uncle);
  console.log('test-live-presence: ok', { room, joeId, uncleId });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
