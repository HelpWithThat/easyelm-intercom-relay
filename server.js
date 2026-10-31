// Easy Elm Intercom relay: live WebSocket forwarder + short-lived inbox (missed calls / voice)
// and username registry. Audio frames stay opaque; inbox payloads are app-provided.
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.APP_TOKEN || '';
const MAX_MSG = 4096;            // bytes per live WS frame
const MAX_MSGS_PER_SEC = 300;
const MAX_BYTES_PER_SEC = 250000;
const MAX_PER_ROOM = 30;
const MAX_CONN_PER_IP = 10;
const ROOM_RE = /^[0-9]{6}$/;
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;
const TTL_MS = 24 * 60 * 60 * 1000;   // inbox expiry
const MAX_VOICE_B64 = 900_000;        // ~675 KB decoded; enough for ~60s AAC
const MAX_INBOX_PER_PEER = 40;

if (!TOKEN) console.warn('APP_TOKEN is not set: every connection will be refused');

const rooms = new Map();   // code -> Set<ws>
const perIp = new Map();
/** @type {Map<string, object[]>} key = `${room}:${toId}` */
const inbox = new Map();
/** @type {Map<string, {username:string, peerId:string, room:string, updatedAt:number}>} */
const usernames = new Map(); // lower -> record
/** peerId -> lower username */
const peerUser = new Map();
/** peerId -> room while WebSocket is connected */
const peerLive = new Map();
/** peerId (string) -> Set of blocked peerIds (string). Silent; blocked party is never told. */
const blocks = new Map();
function setBlocks(peerId, list) {
  const s = new Set((list || []).map(String).filter(Boolean));
  if (!s.size) blocks.delete(String(peerId));
  else blocks.set(String(peerId), s);
  return [...(blocks.get(String(peerId)) || [])];
}
function isBlockedBy(recipientId, senderId) {
  const s = blocks.get(String(recipientId));
  return !!(s && s.has(String(senderId)));
}
/** Peek Proto `from` (bytes 4..11 big-endian uint64) from a live frame. */
function peekFrom(buf) {
  if (!buf || buf.length < 12) return '';
  // Proto stores Java signed long (int64 BE). Match Engine.myId().toString() (may be negative).
  try {
    const n = buf.readBigInt64BE(4);
    return n.toString();
  } catch (_) { return ''; }
}

function now() { return Date.now(); }
function purgeExpired() {
  const t = now();
  for (const [k, list] of inbox) {
    const keep = list.filter(m => t - m.createdAt < TTL_MS);
    if (!keep.length) inbox.delete(k); else inbox.set(k, keep);
  }
}
setInterval(purgeExpired, 60_000);

function auth(req) {
  const url = new URL(req.url, 'http://x');
  const token = req.headers['x-app-token'] || url.searchParams.get('token') || '';
  return TOKEN && token === TOKEN;
}
function readJson(req) {
  return new Promise((ok, bad) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > MAX_VOICE_B64 + 50_000) { bad(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { bad(e); }
    });
    req.on('error', bad);
  });
}
function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(b);
}
function inboxKey(room, toId) { return `${room}:${toId}`; }
function pushInbox(room, toId, item) {
  const k = inboxKey(room, String(toId));
  const list = inbox.get(k) || [];
  list.push(item);
  while (list.length > MAX_INBOX_PER_PEER) list.shift();
  inbox.set(k, list);
  return item;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    return json(res, 200, { ok: true, rooms: rooms.size, inboxKeys: inbox.size, usernames: usernames.size });
  }

  // All /v1/* need the app token (backward-compatible: old clients never call these).
  if (path.startsWith('/v1/')) {
    if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
    try {
      // --- username registry ---
      if (req.method === 'POST' && path === '/v1/username/claim') {
        const body = await readJson(req);
        const raw = String(body.username || '').trim();
        const peerId = String(body.peerId || '');
        const room = String(body.room || '');
        if (!USER_RE.test(raw)) return json(res, 400, { error: 'invalid', message: 'Username must be 3–20 letters, numbers, or underscore.' });
        if (!peerId) return json(res, 400, { error: 'invalid', message: 'Missing peer id.' });
        if (room && !ROOM_RE.test(room)) return json(res, 400, { error: 'invalid', message: 'Bad room.' });
        const key = raw.toLowerCase();
        const existing = usernames.get(key);
        if (existing && existing.peerId !== peerId) {
          return json(res, 409, { error: 'taken', message: 'That username is already taken. Please pick another.' });
        }
        // Release previous name for this peer
        const prev = peerUser.get(peerId);
        if (prev && prev !== key) usernames.delete(prev);
        const rec = { username: raw, peerId, room: room || (existing && existing.room) || '', updatedAt: now() };
        usernames.set(key, rec);
        peerUser.set(peerId, key);
        return json(res, 200, { ok: true, username: rec.username, room: rec.room });
      }
      if (req.method === 'POST' && path === '/v1/username/update-room') {
        const body = await readJson(req);
        const peerId = String(body.peerId || '');
        const room = String(body.room || '');
        if (!peerId || !ROOM_RE.test(room)) return json(res, 400, { error: 'invalid' });
        const key = peerUser.get(peerId);
        if (!key) return json(res, 404, { error: 'none', message: 'No username claimed yet.' });
        const rec = usernames.get(key);
        if (!rec) return json(res, 404, { error: 'none' });
        rec.room = room; rec.updatedAt = now();
        return json(res, 200, { ok: true, username: rec.username, room });
      }
      // --- live presence (peer currently has a WS) ---
      if (req.method === 'GET' && path === '/v1/live') {
        const peer = String(url.searchParams.get('peer') || '').trim();
        if (!peer) return json(res, 400, { error: 'invalid', message: 'Missing peer.' });
        const room = peerLive.get(peer) || null;
        return json(res, 200, { ok: true, peer, live: !!room, room });
      }
      if (req.method === 'GET' && path.startsWith('/v1/username/')) {
        const name = decodeURIComponent(path.slice('/v1/username/'.length)).trim();
        if (!USER_RE.test(name)) return json(res, 400, { error: 'invalid', message: 'That username does not look right.' });
        const rec = usernames.get(name.toLowerCase());
        if (!rec) return json(res, 404, { error: 'not_found', message: 'No phone uses that username yet. Ask them to open the app so it can register.' });
        // Prefer the room the peer is actually connected to right now (avoids stale shared-room claims).
        const live = peerLive.get(String(rec.peerId));
        const roomOut = live || rec.room || null;
        return json(res, 200, {
          username: rec.username, peerId: rec.peerId, room: roomOut,
          live: !!live, registeredRoom: rec.room || null,
        });
      }

      // --- missed call ---
      if (req.method === 'POST' && path === '/v1/missed') {
        const body = await readJson(req);
        const room = String(body.room || '');
        const fromId = String(body.fromId || '');
        const toId = String(body.toId || '');
        const fromName = String(body.fromName || 'Someone').slice(0, 40);
        if (!ROOM_RE.test(room) || !fromId || !toId) return json(res, 400, { error: 'invalid' });
        if (isBlockedBy(toId, fromId)) return json(res, 200, { ok: true, id: null, dropped: 'blocked' });
        const id = crypto.randomBytes(8).toString('hex');
        const item = {
          id, type: 'missed', room, fromId, toId, fromName,
          createdAt: body.at ? Number(body.at) : now(),
        };
        pushInbox(room, toId, item);
        return json(res, 200, { ok: true, id });
      }

      // --- voice message ---
      if (req.method === 'POST' && path === '/v1/voice') {
        const body = await readJson(req);
        const room = String(body.room || '');
        const fromId = String(body.fromId || '');
        const toId = String(body.toId || '');
        const fromName = String(body.fromName || 'Someone').slice(0, 40);
        const audioB64 = String(body.audioB64 || '');
        const mime = String(body.mime || 'audio/mp4').slice(0, 40);
        const durationMs = Math.min(60_000, Math.max(0, Number(body.durationMs) || 0));
        const transcript = body.transcript != null ? String(body.transcript).slice(0, 2000) : null;
        if (!ROOM_RE.test(room) || !fromId || !toId) return json(res, 400, { error: 'invalid' });
        if (!audioB64 || audioB64.length > MAX_VOICE_B64) return json(res, 400, { error: 'audio', message: 'Voice message too large or empty.' });
        if (isBlockedBy(toId, fromId)) return json(res, 200, { ok: true, id: null, dropped: 'blocked' });
        const id = crypto.randomBytes(8).toString('hex');
        const item = {
          id, type: 'voice', room, fromId, toId, fromName,
          audioB64, mime, durationMs, transcript,
          createdAt: body.at ? Number(body.at) : now(),
        };
        pushInbox(room, toId, item);
        return json(res, 200, { ok: true, id });
      }

      // --- fetch inbox ---
      if (req.method === 'GET' && path === '/v1/inbox') {
        const room = url.searchParams.get('room') || '';
        const peer = url.searchParams.get('peer') || '';
        if (!ROOM_RE.test(room) || !peer) return json(res, 400, { error: 'invalid' });
        purgeExpired();
        const list = (inbox.get(inboxKey(room, peer)) || []).slice();
        return json(res, 200, { items: list });
      }

      // --- ack / delete delivered ---
      if (req.method === 'POST' && path === '/v1/ack') {
        const body = await readJson(req);
        const room = String(body.room || '');
        const peer = String(body.peer || body.toId || '');
        const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
        if (!ROOM_RE.test(room) || !peer) return json(res, 400, { error: 'invalid' });
        const k = inboxKey(room, peer);
        const list = inbox.get(k) || [];
        const idset = new Set(ids);
        const keep = list.filter(m => !idset.has(m.id));
        if (!keep.length) inbox.delete(k); else inbox.set(k, keep);
        return json(res, 200, { ok: true, removed: list.length - keep.length });
      }

      if (req.method === 'POST' && path === '/v1/blocks') {
        const body = await readJson(req);
        const peerId = String(body.peerId || '');
        const list = Array.isArray(body.blocked) ? body.blocked : [];
        if (!peerId) return json(res, 400, { error: 'invalid' });
        const saved = setBlocks(peerId, list);
        return json(res, 200, { ok: true, blocked: saved });
      }
      if (req.method === 'GET' && path === '/v1/blocks') {
        const peerId = url.searchParams.get('peer') || '';
        if (!peerId) return json(res, 400, { error: 'invalid' });
        return json(res, 200, { blocked: [...(blocks.get(String(peerId)) || [])] });
      }

      return json(res, 404, { error: 'not_found' });
    } catch (e) {
      console.warn('v1', e.message);
      return json(res, 400, { error: 'bad_request', message: e.message });
    }
  }

  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const room = url.searchParams.get('room') || '';
  const token = req.headers['x-app-token'] || url.searchParams.get('token') || '';
  const peer = (url.searchParams.get('peer') || '').trim();
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const reject = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`); socket.destroy(); };
  if (url.pathname !== '/ws') return reject(404, 'Not Found');
  if (!TOKEN || token !== TOKEN) return reject(401, 'Unauthorized');
  if (!ROOM_RE.test(room)) return reject(400, 'Bad Room');
  if ((perIp.get(ip) || 0) >= MAX_CONN_PER_IP) return reject(429, 'Too Many');
  const set = rooms.get(room);
  if (set && set.size >= MAX_PER_ROOM) return reject(429, 'Room Full');
  wss.handleUpgrade(req, socket, head, ws => join(ws, room, ip, peer));
});

function join(ws, room, ip, peer) {
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  ws.peerId = peer || '';
  if (ws.peerId) peerLive.set(ws.peerId, room);
  let win = Date.now(), msgs = 0, bytes = 0;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    const t = Date.now();
    if (t - win >= 1000) { win = t; msgs = 0; bytes = 0; }
    msgs++; bytes += data.length;
    if (msgs > MAX_MSGS_PER_SEC || bytes > MAX_BYTES_PER_SEC) return;
    if (!isBinary) { if (String(data) === 'ping') ws.send('pong'); return; }
    const fromId = peekFrom(Buffer.isBuffer(data) ? data : Buffer.from(data));
    for (const peer of rooms.get(room) || []) {
      if (peer === ws || peer.readyState !== 1 || peer.bufferedAmount >= 256000) continue;
      if (fromId && peer.peerId && isBlockedBy(peer.peerId, fromId)) continue; // silent drop
      peer.send(data, { binary: true });
    }
  });
  ws.on('close', () => {
    const s = rooms.get(room); if (s) { s.delete(ws); if (!s.size) rooms.delete(room); }
    const n = (perIp.get(ip) || 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
    if (ws.peerId && peerLive.get(ws.peerId) === room) peerLive.delete(ws.peerId);
  });
  ws.on('error', () => {});
}

setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 25000);

server.listen(PORT, () => console.log(`relay listening on ${PORT}`));

// Exported for unit-ish tests when required
module.exports = { USER_RE, ROOM_RE, TTL_MS, purgeExpired, inbox, usernames, peerUser, peerLive, blocks, setBlocks, isBlockedBy, peekFrom };
