// Usage: RELAY=wss://host APP_TOKEN=... node test.js  -> two clients in one room swap a frame; a third in another room hears nothing.
const WebSocket = require('ws');
const base = process.env.RELAY || 'ws://localhost:10000', token = process.env.APP_TOKEN;
const room = String(100000 + Math.floor(Math.random() * 899999));
const open = r => new Promise((ok, bad) => { const w = new WebSocket(`${base}/ws?room=${r}`, { headers: { 'x-app-token': token } }); w.on('open', () => ok(w)); w.on('error', bad); w.on('unexpected-response', (q, res) => bad(new Error('HTTP ' + res.statusCode))); });
(async () => {
  const a = await open(room), b = await open(room), c = await open(room === '123456' ? '654321' : '123456');
  let leaked = false; c.on('message', () => { leaked = true; });
  const got = new Promise(ok => b.on('message', d => ok(Buffer.from(d))));
  const back = new Promise(ok => a.on('message', d => ok(Buffer.from(d))));
  a.send(Buffer.from('hello-from-A'));
  const g = await got; b.send(Buffer.from('reply-from-B')); const h = await back;
  let bad = 'no'; try { await open('abc'); bad = 'accepted'; } catch (e) { bad = e.message; }
  let notok = 'no'; try { await new Promise((ok, no) => { const w = new WebSocket(`${base}/ws?room=${room}`, { headers: { 'x-app-token': 'wrong' } }); w.on('open', () => ok()); w.on('unexpected-response', (q, r) => no(new Error('HTTP ' + r.statusCode))); w.on('error', no); }); notok = 'accepted'; } catch (e) { notok = e.message; }
  await new Promise(r => setTimeout(r, 500));
  console.log({ room, BgotFromA: g.toString(), AgotFromB: h.toString(), otherRoomLeaked: leaked, badRoom: bad, wrongToken: notok });
  [a, b, c].forEach(w => w.close()); process.exit(g.toString() === 'hello-from-A' && h.toString() === 'reply-from-B' && !leaked && notok !== 'accepted' ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
