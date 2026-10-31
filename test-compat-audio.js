// Old client (no ?peer=) <-> new client (?peer=): both must receive binary audio-shaped frames.
// RELAY=https://host APP_TOKEN=... node test-compat-audio.js
const WebSocket = require('ws');
const baseHttp = (process.env.RELAY || 'http://localhost:10000').replace(/\/$/, '')
  .replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const baseWs = baseHttp.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
const token = process.env.APP_TOKEN;
if (!token) { console.error('APP_TOKEN required'); process.exit(1); }

const room = String(100000 + Math.floor(Math.random() * 899999));
const joeId = '-424242424242'; // typical signed long string
const uncleId = '9876543210';

function frameFrom(fromIdStr) {
  const buf = Buffer.alloc(17 + 12 + 8); // header + fake iv+tag-ish payload
  buf[0] = 0x45; buf[1] = 0x49; buf[2] = 1; buf[3] = 2; // AUDIO
  const n = BigInt(fromIdStr);
  buf.writeBigInt64BE(n, 4);
  buf[12] = 0; // everyone=false (unicast-style, as 0.8+ person talk)
  buf.writeUInt32BE(1, 13);
  buf.fill(0xab, 17);
  return buf;
}

function open(pathExtra) {
  return new Promise((ok, bad) => {
    const w = new WebSocket(`${baseWs}/ws?room=${room}&token=${encodeURIComponent(token)}${pathExtra}`);
    w.on('open', () => ok(w));
    w.on('error', bad);
    w.on('unexpected-response', (q, res) => bad(new Error('HTTP ' + res.statusCode)));
  });
}

(async () => {
  await fetch(baseHttp + '/health');
  // New client (Joe) with peer=; old client (uncle) without peer=
  const joe = await open(`&peer=${encodeURIComponent(joeId)}`);
  const uncle = await open(''); // old Holo 0.4–0.7 style
  let uncleGot = false, joeGot = false;
  uncle.on('message', (d) => {
    const b = Buffer.from(d);
    if (b.length >= 12 && b.readBigInt64BE(4).toString() === joeId) uncleGot = true;
  });
  joe.on('message', (d) => {
    const b = Buffer.from(d);
    if (b.length >= 12 && b.readBigInt64BE(4).toString() === uncleId) joeGot = true;
  });
  await new Promise(r => setTimeout(r, 300));
  // Joe talks (everyone=false) — must reach old uncle
  joe.send(frameFrom(joeId));
  // Uncle talks — must reach Joe
  uncle.send(frameFrom(uncleId));
  await new Promise(r => setTimeout(r, 800));
  console.log({ uncleGotJoeAudio: uncleGot, joeGotUncleAudio: joeGot, room });
  joe.close(); uncle.close();
  if (!uncleGot || !joeGot) {
    console.error('compat fail');
    process.exit(1);
  }
  console.log('test-compat-audio: ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
