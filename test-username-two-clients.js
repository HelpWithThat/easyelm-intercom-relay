// Two simulated phones: JustOne23 looks up Muncher after both claim (and after they share a room).
// Must NOT report "own username" when looking up the other; same-room lookup should be "already linked".
const baseHttp = (process.env.RELAY || 'http://localhost:10000').replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const token = process.env.APP_TOKEN;
if (!token) { console.error('APP_TOKEN required'); process.exit(1); }
const headers = { 'x-app-token': token, 'content-type': 'application/json' };
async function api(method, path, body) {
  const r = await fetch(baseHttp + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = JSON.parse(await r.text());
  return { status: r.status, j };
}
function chosenRoom(a, b) { return a < b ? a : b; }

(async () => {
  await fetch(baseHttp + '/health');
  const roomA = String(100000 + Math.floor(Math.random() * 400000));
  const roomB = String(500000 + Math.floor(Math.random() * 400000));
  const idA = '9001', idB = '9002';
  const userA = 'JustOne23_' + roomA.slice(0, 3);
  const userB = 'Muncher_' + roomB.slice(0, 3);

  // Each phone claims its username on its own room (first launch)
  let r = await api('POST', '/v1/username/claim', { username: userA, peerId: idA, room: roomA });
  if (r.status !== 200) throw new Error('claim A ' + JSON.stringify(r));
  r = await api('POST', '/v1/username/claim', { username: userB, peerId: idB, room: roomB });
  if (r.status !== 200) throw new Error('claim B ' + JSON.stringify(r));

  // A looks up B before linking — should get B's room, not A's
  r = await api('GET', '/v1/username/' + userB);
  if (r.status !== 200) throw new Error('lookup B before link ' + JSON.stringify(r));
  if (r.j.room !== roomB) throw new Error('expected roomB, got ' + r.j.room);
  if (r.j.peerId !== idB) throw new Error('expected peer B');
  if (r.j.room === roomA) throw new Error('BUG: lookup returned caller room');

  // Simulate link: both move to min(roomA, roomB) and re-claim
  const shared = chosenRoom(roomA, roomB);
  await api('POST', '/v1/username/claim', { username: userA, peerId: idA, room: shared });
  await api('POST', '/v1/username/claim', { username: userB, peerId: idB, room: shared });

  // After link, A looks up B — rooms match (shared). Client must treat as already-linked, NOT own username.
  r = await api('GET', '/v1/username/' + userB);
  if (r.status !== 200) throw new Error('lookup after link');
  const lookRoom = r.j.room;
  const lookPeer = r.j.peerId;
  const isOwnUsername = lookPeer === idA || userB.toLowerCase() === userA.toLowerCase();
  const sameRoom = lookRoom === shared; // A's current room
  if (isOwnUsername) throw new Error('false own-username');
  if (!sameRoom) throw new Error('expected shared room after link');
  console.log('after-link lookup OK: treat as already-linked', { lookPeer, lookRoom, shared });

  // Looking up own username by peer id
  r = await api('GET', '/v1/username/' + userA);
  if (r.j.peerId !== idA) throw new Error('own lookup peer');
  console.log('own lookup correctly identifies peerId', idA);

  // Missing username
  r = await api('GET', '/v1/username/NoSuchUser999');
  if (r.status !== 404) throw new Error('expected 404');
  console.log('not-found message:', r.j.message);

  // Re-register after wipe simulation: delete by reclaiming from other then reclaim — use fresh claim after "restart"
  // (in-memory can't wipe easily; claim again with same peer restores)
  r = await api('POST', '/v1/username/claim', { username: userB, peerId: idB, room: shared });
  if (r.status !== 200) throw new Error('reclaim');
  console.log('OK', { userA, userB, shared, verified: ['pre-link lookup', 'post-link same-room != own', 'own peerId', '404', 'reclaim'] });
})().catch(e => { console.error(e); process.exit(1); });
