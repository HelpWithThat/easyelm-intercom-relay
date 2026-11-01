const WebSocket = require('ws');
const http = require('http');
const assert = require('assert');

const RELAY = process.env.RELAY || 'http://127.0.0.1:19100';
const TOKEN = process.env.APP_TOKEN;
const room = '424242';
const sender = '111';
const recipient = '222';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, RELAY);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(u, {
      method,
      headers: {
        'x-app-token': TOKEN,
        'content-type': 'application/json',
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let j = null; try { j = JSON.parse(raw); } catch {}
        resolve({ code: res.statusCode, j, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function audioFrame(fromId, seq) {
  const b = Buffer.alloc(17 + 32);
  b[0] = 0x45; b[1] = 0x49; b[2] = 1; b[3] = 2;
  b.writeBigInt64BE(BigInt(fromId), 4);
  b[12] = 0; b.writeInt32BE(seq, 13);
  b.fill(0xcd, 17);
  return b;
}
function endFrame(fromId) {
  const b = Buffer.alloc(12);
  b[0] = 0x45; b[1] = 0x49; b[2] = 1; b[3] = 3;
  b.writeBigInt64BE(BigInt(fromId), 4);
  return b;
}

function connect(peer) {
  const base = RELAY.replace('http', 'ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/ws?room=${room}&token=${encodeURIComponent(TOKEN)}&peer=${peer}`, {
      headers: { 'x-app-token': TOKEN },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

(async () => {
  // Both join
  const wsS = await connect(sender);
  const wsR = await connect(recipient);
  await new Promise(r => setTimeout(r, 100));

  // Abrupt disconnect recipient (no leave — simulates data kill)
  wsR.terminate();
  await new Promise(r => setTimeout(r, 50));

  // Sender talks — frames should be undelivered & buffered
  for (let i = 0; i < 8; i++) wsS.send(audioFrame(Number(sender), i));
  wsS.send(endFrame(Number(sender)));
  await new Promise(r => setTimeout(r, 150));
  wsS.close();

  // Recipient inbox should have sealed voice via dual-index
  const inbox = await req('GET', `/v1/inbox?room=${room}&peer=${recipient}`);
  assert.strictEqual(inbox.code, 200, JSON.stringify(inbox));
  const items = inbox.j.items || inbox.j.messages || inbox.j || [];
  const list = Array.isArray(items) ? items : (items.items || []);
  const voice = list.filter(m => m.type === 'voice' && m.mime === 'application/x-holo-sealed');
  assert.ok(voice.length >= 1, 'expected sealed voice in inbox, got ' + JSON.stringify(inbox.j));
  console.log('OK abrupt-offline server fallback', { voice: voice.length, id: voice[0].id });
})().catch(e => { console.error('FAIL', e); process.exit(1); });
