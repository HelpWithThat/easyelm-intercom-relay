// Verify block list drops inbox + live WS frames. Usage:
//   RELAY=https://host APP_TOKEN=... node test-blocks.js
const WebSocket = require('ws');
const baseHttp = (process.env.RELAY || 'http://localhost:10000').replace(/\/$/, '')
  .replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const baseWs = baseHttp.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
const token = process.env.APP_TOKEN;
if (!token) { console.error('APP_TOKEN required'); process.exit(1); }

const room = String(100000 + Math.floor(Math.random() * 899999));
const joe = '9001', bother = '9002', other = '9003';
const headers = { 'x-app-token': token, 'content-type': 'application/json' };

async function api(method, path, body) {
  const r = await fetch(baseHttp + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  return { status: r.status, j };
}

function open(peer) {
  return new Promise((ok, bad) => {
    const w = new WebSocket(`${baseWs}/ws?room=${room}&peer=${peer}&token=${encodeURIComponent(token)}`);
    w.on('open', () => ok(w));
    w.on('error', bad);
    w.on('unexpected-response', (q, res) => bad(new Error('HTTP ' + res.statusCode)));
  });
}

function frameFrom(fromId) {
  const buf = Buffer.alloc(17);
  buf[0] = 0xEE; buf[1] = 0x1C; buf[2] = 1; buf[3] = 2; // AUDIO-ish
  // from as uint64 BE
  const n = BigInt(fromId);
  buf.writeUInt32BE(Number(n >> 32n), 4);
  buf.writeUInt32BE(Number(n & 0xffffffffn), 8);
  buf[12] = 0; buf.writeUInt32BE(1, 13);
  return buf;
}

(async () => {
  await fetch(baseHttp + '/health');

  // Joe blocks bother
  const set = await api('POST', '/v1/blocks', { peerId: joe, blocked: [bother] });
  console.log('set blocks', set.status, set.j);
  if (set.status !== 200) throw new Error('set blocks failed');

  // Inbox voice from bother → joe must be dropped
  const voice = await api('POST', '/v1/voice', {
    room, fromId: bother, toId: joe, fromName: 'Bother',
    audioB64: Buffer.from('fakeaudio').toString('base64'), mime: 'audio/mp4', durationMs: 500,
  });
  console.log('voice blocked', voice.status, voice.j);
  if (voice.status !== 200 || voice.j.dropped !== 'blocked') throw new Error('expected dropped blocked voice');

  // Inbox from other → joe OK
  const voice2 = await api('POST', '/v1/voice', {
    room, fromId: other, toId: joe, fromName: 'Other',
    audioB64: Buffer.from('fakeaudio2').toString('base64'), mime: 'audio/mp4', durationMs: 500,
  });
  console.log('voice other', voice2.status, voice2.j);
  if (voice2.status !== 200 || !voice2.j.id) throw new Error('other voice should land');

  const inbox = await api('GET', `/v1/inbox?room=${room}&peer=${joe}`);
  const froms = (inbox.j.items || []).map(i => i.fromId);
  console.log('inbox froms', froms);
  if (froms.includes(bother)) throw new Error('blocked sender still in inbox');
  if (!froms.includes(other)) throw new Error('other missing from inbox');

  // Live WS: bother frame must not reach joe; other frame must
  const wJoe = await open(joe);
  const wBother = await open(bother);
  const wOther = await open(other);
  let gotBother = false, gotOther = false;
  wJoe.on('message', (d) => {
    const b = Buffer.from(d);
    if (b.length >= 12) {
      const hi = b.readUInt32BE(4), lo = b.readUInt32BE(8);
      const from = (BigInt(hi) * 4294967296n + BigInt(lo)).toString();
      if (from === bother) gotBother = true;
      if (from === other) gotOther = true;
    }
  });
  await new Promise(r => setTimeout(r, 200));
  wBother.send(frameFrom(bother));
  wOther.send(frameFrom(other));
  await new Promise(r => setTimeout(r, 800));
  console.log({ gotBother, gotOther });
  wJoe.close(); wBother.close(); wOther.close();

  // Clear blocks
  await api('POST', '/v1/blocks', { peerId: joe, blocked: [] });

  if (gotBother) throw new Error('live frame from blocked peer reached joe');
  if (!gotOther) throw new Error('live frame from other did not reach joe');
  console.log('test-blocks: ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
