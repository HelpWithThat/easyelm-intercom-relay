// RELAY=https://host APP_TOKEN=... node test-inbox-peer-key.js
// Simulates: Joni posts voice under shared room A; Joe's room drifts to personal B;
// Joe must still fetch the message (0.12 peer-keyed inbox).
const baseHttp = (process.env.RELAY || 'http://localhost:10000').replace(/\/$/, '')
  .replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const token = process.env.APP_TOKEN;
if (!token) { console.error('APP_TOKEN required'); process.exit(1); }

async function req(method, path, body) {
  const r = await fetch(baseHttp + path, {
    method,
    headers: { 'x-app-token': token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { code: r.status, j };
}

(async () => {
  const roomShared = String(100000 + Math.floor(Math.random() * 400000));
  const roomDrift = String(500000 + Math.floor(Math.random() * 400000));
  const joeId = String(-(600000000000 + Math.floor(Math.random() * 1e8)));
  const joniId = String(7000000000 + Math.floor(Math.random() * 1e8));
  // tiny valid-ish b64 payload
  const audioB64 = Buffer.from('fake-aac-bytes-for-test-0123456789').toString('base64');

  let r = await req('POST', '/v1/voice', {
    room: roomShared, fromId: joniId, toId: joeId, fromName: 'Joni',
    audioB64, mime: 'audio/mp4', durationMs: 1200, transcript: 'hello joe',
  });
  if (r.code !== 200 || !r.j.id) throw new Error('post voice ' + JSON.stringify(r));
  const id = r.j.id;

  // Old-style poll with SHARED room still works
  r = await req('GET', `/v1/inbox?room=${roomShared}&peer=${encodeURIComponent(joeId)}`);
  if (r.code !== 200 || !(r.j.items || []).some(i => i.id === id)) {
    throw new Error('fetch shared ' + JSON.stringify(r));
  }

  // Critical: Joe's room drifted to personal code — must still see the message
  r = await req('GET', `/v1/inbox?room=${roomDrift}&peer=${encodeURIComponent(joeId)}`);
  if (r.code !== 200 || !(r.j.items || []).some(i => i.id === id && i.transcript === 'hello joe')) {
    throw new Error('fetch drifted ' + JSON.stringify(r));
  }

  r = await req('POST', '/v1/ack', { room: roomDrift, peer: joeId, ids: [id] });
  if (r.code !== 200 || !r.j.ok) throw new Error('ack ' + JSON.stringify(r));

  r = await req('GET', `/v1/inbox?room=${roomDrift}&peer=${encodeURIComponent(joeId)}`);
  if ((r.j.items || []).some(i => i.id === id)) throw new Error('still present after ack');

  console.log('OK inbox peer-key survives room drift', { roomShared, roomDrift, id });
})().catch(e => { console.error(e); process.exit(1); });
