// RELAY unused — unit test against required server module (in-process).
const assert = require('assert');
const {
  peekType, appendUndelivered, flushUndelivered, undelivered, pushInbox, collectInbox, inbox, peerLive, roomRecent,
} = require('./server.js');

function audioFrame(fromIdBig, seq) {
  // Proto head: EI v1 AUDIO(2) + int64 BE from + everyone + seq
  const b = Buffer.alloc(17 + 8); // header + fake sealed stub
  b[0] = 0x45; b[1] = 0x49; b[2] = 1; b[3] = 2;
  b.writeBigInt64BE(BigInt(fromIdBig), 4);
  b[12] = 0;
  b.writeInt32BE(seq, 13);
  b.fill(0xab, 17);
  return b;
}
function endFrame(fromIdBig) {
  const b = Buffer.alloc(12);
  b[0] = 0x45; b[1] = 0x49; b[2] = 1; b[3] = 3;
  b.writeBigInt64BE(BigInt(fromIdBig), 4);
  return b;
}

assert.strictEqual(peekType(audioFrame(42, 0)), 2);
assert.strictEqual(peekType(endFrame(42)), 3);

const from = '42';
const room = '123456';
const to = '99';
roomRecent.set(room, new Map([[to, Date.now()]]));

for (let i = 0; i < 5; i++) appendUndelivered(room, from, audioFrame(42, i));
const flushed = flushUndelivered(from, 'Sender');
assert.ok(flushed && flushed.item);
assert.strictEqual(flushed.item.mime, 'application/x-holo-sealed');
assert.ok(flushed.item.audioB64.length > 20);

// Simulate END targeting via roomRecent
const copy = Object.assign({}, flushed.item, { id: 'test1', toId: to });
pushInbox(room, to, copy);
const got = collectInbox(room, to);
assert.ok(got.some(m => m.id === 'test1' && m.mime === 'application/x-holo-sealed'), JSON.stringify(got));
console.log('OK undelivered voice fallback', { bytes: Buffer.from(flushed.item.audioB64, 'base64').length, inbox: got.length });
process.exit(0);
