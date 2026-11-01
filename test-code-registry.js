// RELAY=https://host APP_TOKEN=... node test-code-registry.js
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
  const codeA = String(100000 + Math.floor(Math.random() * 899999));
  const codeB = String(100000 + Math.floor(Math.random() * 899999));
  const peerA = String(-(500000000000 + Math.floor(Math.random() * 1e8)));
  const peerB = String(8000000000 + Math.floor(Math.random() * 1e8));
  const roomShared = codeA < codeB ? codeA : codeB;

  let r = await req('POST', '/v1/code/claim', { code: codeA, peerId: peerA, room: codeA });
  if (r.code !== 200) throw new Error('claim A ' + JSON.stringify(r));
  r = await req('POST', '/v1/code/claim', { code: codeB, peerId: peerB, room: codeB });
  if (r.code !== 200) throw new Error('claim B ' + JSON.stringify(r));

  // After link, B moves to shared room — personal code B still resolves to shared room
  r = await req('POST', '/v1/code/update-room', { peerId: peerB, room: roomShared });
  if (r.code !== 200) throw new Error('update B ' + JSON.stringify(r));

  r = await req('GET', '/v1/code/' + codeB);
  if (r.code !== 200 || r.j.room !== roomShared) throw new Error('lookup B ' + JSON.stringify(r));
  r = await req('GET', '/v1/code/' + codeA);
  if (r.code !== 200 || r.j.peerId !== peerA) throw new Error('lookup A ' + JSON.stringify(r));

  // Conflict: other peer cannot steal codeA
  r = await req('POST', '/v1/code/claim', { code: codeA, peerId: peerB, room: roomShared });
  if (r.code !== 409) throw new Error('expected 409 got ' + JSON.stringify(r));

  console.log('OK code registry', { codeA, codeB, roomShared });
})().catch(e => { console.error(e); process.exit(1); });
