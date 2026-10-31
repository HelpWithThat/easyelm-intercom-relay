// Verify /v1/live + reconnect: peer shows live while WS open, not after close;
// second client in same room still receives frames after reconnect.
// RELAY=https://host APP_TOKEN=... node test-live-presence.js
const WebSocket = require('ws');
const baseHttp = (process.env.RELAY || 'http://localhost:10000').replace(/\/$/, '')
  .replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const baseWs = baseHttp.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
const token = process.env.APP_TOKEN;
if (!token) { console.error('APP_TOKEN required'); process.exit(1); }

const room = String(100000 + Math.floor(Math.random() * 899999));
const joeId = '-424242424242';
const uncleId = '9876543210';

async function live(peer) {
  const r = await fetch(`${baseHttp}/v1/live?peer=${encodeURIComponent(peer)}`, {
    headers: { 'x-app-token': token },
  });
  const j = await r.json();
  return j;
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

  // Joe receives uncle audio (simulates hearing)
  let joeGot = false;
  joe.on('message', () => { joeGot = true; });
  uncle.send(frameFrom(uncleId));
  await new Promise(r => setTimeout(r, 400));
  if (!joeGot) throw new Error('joe did not hear uncle');

  // Reconnect uncle (drop + re-open) — presence must recover
  uncle.close();
  await new Promise(r => setTimeout(r, 300));
  let b = await live(uncleId);
  if (b.live) throw new Error('uncle should be offline after close');

  uncle = await open(uncleId);
  await new Promise(r => setTimeout(r, 200));
  let c = await live(uncleId);
  if (!c.live) throw new Error('uncle should be live after reconnect');

  // After reconnect, Joe talk reaches uncle
  let uncleGot = false;
  uncle.on('message', (d) => {
    const buf = Buffer.from(d);
    if (buf.length >= 12 && buf.readBigInt64BE(4).toString() === joeId) uncleGot = true;
  });
  joe.send(frameFrom(joeId));
  await new Promise(r => setTimeout(r, 500));
  if (!uncleGot) throw new Error('uncle did not get joe audio after reconnect');

  // Old client style (no peer=) still works; /v1/live for them is false (no peer id) — OK
  const old = await open('');
  old.close();

  joe.close(); uncle.close();
  console.log('test-live-presence: ok', { room });
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
