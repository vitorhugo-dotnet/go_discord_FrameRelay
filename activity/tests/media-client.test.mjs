import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MediaClient, MediaDisconnectedError } from '../src/media-client.ts';
import { encodeMediaMessage } from '../src/media-protocol.ts';
globalThis.location = { href: 'https://activity.example/' };
Object.defineProperty(globalThis, 'RTCPeerConnection', { get() { throw new Error('RTC must not be accessed'); } });
let socket;
globalThis.WebSocket = class {
 static OPEN = 1;
 constructor(url, protocol) { socket = this; this.url = url; this.protocol = protocol; this.readyState = 1; this.bufferedAmount = 0; this.sent = [];
  queueMicrotask(() => this.onopen?.()); }
 send(data) { this.sent.push(data); }
 close() { this.wasClosed = true; }
};
const admission = { grant: 'secret', mediaUrl: 'wss://upload.example/private', admissionId: 'admission' };
test('uses mapped media URL and first-message grant; abort releases once', async () => {
 let releases = 0, stopped = 0; const abort = new AbortController();
 const client = new MediaClient(async () => { releases++; });
 await client.connect(admission, { stop() { stopped++; }, async accept() {}, recover() {} }, abort.signal);
 assert.equal(socket.url.href, 'wss://activity.example/media/ws/media');
 assert.equal(socket.url.search, ''); assert.equal(socket.protocol, 'framerelay-media-v1');
 assert.deepEqual(JSON.parse(socket.sent[0]), { grant: 'secret' });
 client.requestKeyframe(); client.requestKeyframe(); assert.equal(socket.sent.length, 2);
 abort.abort(); await client.close(); await client.close(); assert.equal(releases, 1); assert.ok(stopped > 0); assert.ok(socket.wasClosed);
});
test('decoder configuration failure releases allocated admission', async () => {
 let releases = 0, failures = 0; const client = new MediaClient(async () => { releases++; }, error => { assert.ok(!(error instanceof MediaDisconnectedError)); failures++; });
 await client.connect(admission, { stop() {}, async accept() { throw new Error('unsupported codec'); }, recover() {} }, new AbortController().signal);
 socket.onmessage({ data: encodeMediaMessage({ type: 1, flags: 0, generation: 1, sequence: 0, timestampUs: 0, durationUs: 0, payload: new Uint8Array() }).buffer });
 await new Promise(resolve => setImmediate(resolve)); assert.equal(releases, 1); assert.equal(failures, 1); assert.ok(socket.wasClosed);
});
test('Activity flow contains no RTC construction or TURN request', () => {
 const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
 assert.doesNotMatch(source, /RTCPeerConnection|RTCRtpReceiver|ice-servers|ws\/signaling/);
 assert.match(source, /transport: 'websocket'/);
});
