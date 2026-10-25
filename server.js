// Easy Elm Intercom relay: forwards binary frames between phones that share a room code.
// Nothing is stored. Audio is end-to-end encrypted by the phones; the relay only sees opaque bytes.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.APP_TOKEN || '';
const MAX_MSG = 4096;            // bytes per frame
const MAX_MSGS_PER_SEC = 300;    // per connection (audio is ~50/s per listener)
const MAX_BYTES_PER_SEC = 250000;
const MAX_PER_ROOM = 30;
const MAX_CONN_PER_IP = 10;
const ROOM_RE = /^[0-9]{6}$/;

if (!TOKEN) console.warn('APP_TOKEN is not set: every connection will be refused');

const rooms = new Map();   // code -> Set<ws>
const perIp = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  } else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const room = url.searchParams.get('room') || '';
  const token = req.headers['x-app-token'] || url.searchParams.get('token') || '';
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const reject = (code, msg) => { socket.write(`HTTP/1.1 ${code} ${msg}\r\n\r\n`); socket.destroy(); };
  if (url.pathname !== '/ws') return reject(404, 'Not Found');
  if (!TOKEN || token !== TOKEN) return reject(401, 'Unauthorized');
  if (!ROOM_RE.test(room)) return reject(400, 'Bad Room');
  if ((perIp.get(ip) || 0) >= MAX_CONN_PER_IP) return reject(429, 'Too Many');
  const set = rooms.get(room);
  if (set && set.size >= MAX_PER_ROOM) return reject(429, 'Room Full');
  wss.handleUpgrade(req, socket, head, ws => join(ws, room, ip));
});

function join(ws, room, ip) {
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  let win = Date.now(), msgs = 0, bytes = 0;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - win >= 1000) { win = now; msgs = 0; bytes = 0; }
    msgs++; bytes += data.length;
    if (msgs > MAX_MSGS_PER_SEC || bytes > MAX_BYTES_PER_SEC) return; // drop over-limit frames
    if (!isBinary) { if (String(data) === 'ping') ws.send('pong'); return; }
    for (const peer of rooms.get(room) || []) {
      if (peer !== ws && peer.readyState === 1 && peer.bufferedAmount < 256000) peer.send(data, { binary: true });
    }
  });
  ws.on('close', () => {
    const s = rooms.get(room); if (s) { s.delete(ws); if (!s.size) rooms.delete(room); }
    const n = (perIp.get(ip) || 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n);
  });
  ws.on('error', () => {});
}

setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 25000);

server.listen(PORT, () => console.log(`relay listening on ${PORT}`));
