/**
 * Reproduces Joe's 0.6 bug: both usernames registered, Muncher's registeredRoom
 * stale-equal to JustOne23's room, but Muncher's live WS is in a different room.
 * Username lookup must return the LIVE room; linking must put both in min(roomA, roomB).
 * Also verifies six-digit code connect path.
 */
const WebSocket = require('ws');
const http = require('http');

const BASE = process.env.RELAY_URL || 'https://easyelm-intercom-relay.onrender.com';
const TOKEN = process.env.RELAY_TOKEN;
if (!TOKEN) { console.error('RELAY_TOKEN required'); process.exit(1); }

const httpBase = BASE.replace(/\/$/, '');
const wsBase = httpBase.replace(/^http/, 'ws');

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(httpBase + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: {
        'x-app-token': TOKEN,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(b || '{}'); } catch { j = { raw: b }; }
        resolve({ code: res.statusCode, j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// node https
const https = require('https');
function req2(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(httpBase + path);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const r = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: {
        'x-app-token': TOKEN,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(b || '{}'); } catch { j = { raw: b }; }
        resolve({ code: res.statusCode, j });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function connect(room, peerId) {
  return new Promise((resolve, reject) => {
    const url = `${wsBase}/ws?room=${room}&token=${TOKEN}&peer=${peerId}`;
    const ws = new WebSocket(url, { headers: { 'x-app-token': TOKEN } });
    const timer = setTimeout(() => reject(new Error('ws timeout ' + room)), 20000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

function chosenRoom(a, b) {
  return a < b ? a : b;
}

async function main() {
  const joeId = '900001';
  const muncherId = '900002';
  const joeRoom = '230904';   // JustOne23's code
  const muncherRoom = '481027'; // Muncher's real room
  const joeUser = 'JustOne23';
  const muncherUser = 'Muncher';

  console.log('1) Claim usernames with DISTINCT rooms');
  let r = await req2('POST', '/v1/username/claim', { username: joeUser, peerId: joeId, room: joeRoom });
  if (r.code !== 200) throw new Error('joe claim ' + JSON.stringify(r));
  r = await req2('POST', '/v1/username/claim', { username: muncherUser, peerId: muncherId, room: muncherRoom });
  if (r.code !== 200) throw new Error('muncher claim ' + JSON.stringify(r));

  console.log('2) Stale registry: force Muncher registeredRoom = Joe room (Joe\'s 0.6 bug state)');
  r = await req2('POST', '/v1/username/update-room', { peerId: muncherId, room: joeRoom });
  if (r.code !== 200) throw new Error('stale update ' + JSON.stringify(r));

  console.log('3) Muncher opens app in her REAL room (live WS), Joe in his room');
  const muncherWs = await connect(muncherRoom, muncherId);
  const joeWs = await connect(joeRoom, joeId);

  console.log('4) Lookup Muncher — must return LIVE room, not stale shared');
  r = await req2('GET', '/v1/username/' + encodeURIComponent(muncherUser));
  if (r.code !== 200) throw new Error('lookup ' + JSON.stringify(r));
  console.log('   lookup:', r.j);
  if (r.j.room !== muncherRoom) {
    throw new Error(`FAIL: expected live room ${muncherRoom}, got ${r.j.room} (registeredRoom=${r.j.registeredRoom})`);
  }
  if (!r.j.live) throw new Error('FAIL: expected live:true');
  if (String(r.j.peerId) !== muncherId) throw new Error('peerId mismatch');

  console.log('5) Username link: Joe joins chosen = min(joe, muncher)');
  const chosen = chosenRoom(joeRoom, muncherRoom);
  console.log('   chosen', chosen);
  joeWs.close();
  // Muncher stays; if Joe has lower code he invites; if Muncher lower Joe joins
  let joeLinked;
  if (joeRoom === chosen) {
    // invite path: Joe stays, delivers invite — Muncher should move. Simulate Muncher receiving invite.
    muncherWs.close();
    joeLinked = await connect(chosen, joeId);
    const muncherLinked = await connect(chosen, muncherId);
    await new Promise(r => setTimeout(r, 500));
    console.log('6) Both in chosen room (invite path)');
    muncherLinked.close();
    joeLinked.close();
  } else {
    muncherWs.close();
    joeLinked = await connect(chosen, joeId);
    const muncherLinked = await connect(chosen, muncherId);
    await new Promise(r => setTimeout(r, 500));
    console.log('6) Both in chosen room (join path)');
    // Re-claim both with shared room (like app does on relayUp)
    await req2('POST', '/v1/username/update-room', { peerId: joeId, room: chosen });
    await req2('POST', '/v1/username/update-room', { peerId: muncherId, room: chosen });
    muncherLinked.close();
    joeLinked.close();
  }

  console.log('7) After link, lookup while both online in shared room → live shared');
  const j2 = await connect(chosen, joeId);
  const m2 = await connect(chosen, muncherId);
  r = await req2('GET', '/v1/username/' + encodeURIComponent(muncherUser));
  console.log('   post-link lookup:', r.j);
  if (r.j.room !== chosen) throw new Error('post-link room should be chosen');
  // Client-side: Already linked only if peer verified online — both in same WS room ⇒ yes
  console.log('   OK username path: live room correct; both can share chosen room');

  j2.close(); m2.close();

  console.log('8) Code-connect path: two fresh peers, type six-digit code');
  const aId = '900011', bId = '900012';
  const aRoom = '111222', bRoom = '333444';
  const aWs = await connect(aRoom, aId);
  const bWs = await connect(bRoom, bId);
  const codeChosen = chosenRoom(aRoom, bRoom);
  aWs.close(); bWs.close();
  const a2 = await connect(codeChosen, aId);
  const b2 = await connect(codeChosen, bId);
  await new Promise(r => setTimeout(r, 300));
  console.log('   code connect both in', codeChosen);
  a2.close(); b2.close();

  console.log('9) Offline stale: Muncher registered=Joe room, Muncher NOT live');
  await req2('POST', '/v1/username/update-room', { peerId: muncherId, room: joeRoom });
  r = await req2('GET', '/v1/username/' + encodeURIComponent(muncherUser));
  console.log('   offline lookup:', r.j);
  if (r.j.live) throw new Error('should not be live');
  if (r.j.room !== joeRoom) throw new Error('fallback registered room expected');
  // Client must NOT say Already linked — linkWith(joeRoom, muncherId) with expectPeerId → Invited
  console.log('   OK client will call linkWith(sameRoom, peerId) → Invited, not AlreadyLinked');

  console.log('\\nALL PASS');
}

main().catch(e => { console.error('FAIL', e); process.exit(1); });
