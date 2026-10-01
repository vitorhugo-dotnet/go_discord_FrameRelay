import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaPlayer } from '../src/media-player.ts';
const config = { video: { codec: 'avc1.42e01f', width: 640, height: 360, format: 'annexb' }, audio: null };
let outputs, decoded, closed, requests, supported, throwDecode;
class Decoder {
 static async isConfigSupported(c) { return { supported, config: c }; }
 constructor(callbacks) { outputs = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; }
 configure(c) { this.state = 'configured'; this.config = c; }
 decode(c) { if (throwDecode) throw throwDecode; decoded.push(c); }
 reset() { this.state = 'unconfigured'; }
 close() { this.state = 'closed'; closed++; }
}
globalThis.VideoDecoder = Decoder;
globalThis.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
function player(onDiagnostic = () => {}) { decoded = []; closed = requests = 0; supported = true; throwDecode = undefined; return new MediaPlayer(canvas, () => requests++, () => {}, () => {}, onDiagnostic); }
function message(type, sequence, flags = 0, generation = 1) {
 return { type, sequence, flags, generation, timestampUs: sequence * 16667, durationUs: 16667,
  payload: type === 1 ? new TextEncoder().encode(JSON.stringify(config)) : new Uint8Array([1]) };
}
test('waits for keyframe and closes every output', async () => {
 const p = player(); await p.accept(message(1, 0)); await p.accept(message(2, 1)); assert.equal(decoded.length, 0);
 await p.accept(message(2, 2, 1)); assert.equal(decoded.length, 1);
 let released = 0; outputs.output({ timestamp: 33334, close() { released++; } });
 p.stop(); assert.equal(released, 1); assert.equal(closed, 1);
});
test('stale generation and video backlog require recovery', async () => {
 const p = player(); await p.accept(message(1, 0)); await p.accept(message(2, 1, 1));
 await p.accept(message(2, 2, 0, 0)); assert.equal(decoded.length, 1);
 p.video.decodeQueueSize = 8; await p.accept(message(2, 2)); assert.ok(requests > 0);
 p.stop();
});
test('rejects unsupported exact codec before decoding', async () => {
 const p = player(); supported = false; await assert.rejects(p.accept(message(1, 0)), /H.264/); p.stop();
});
test('closed decoder is recreated and recovers on a fresh keyframe', async () => {
 const p = player(); await p.accept(message(1, 0)); await p.accept(message(2, 1, 1));
 p.video.state = 'closed'; outputs.error(new Error('decode failed'));
 await p.accept(message(2, 2, 1)); assert.equal(decoded.length, 2); p.stop();
});

test('startup failure distinguishes missing transport from decoder failure', async () => {
 const p = player(); assert.match(p.startupFailure(), /No media configuration/);
 await p.accept(message(1, 0)); assert.match(p.startupFailure(), /No video packets/);
 await p.accept(message(2, 1, 1));
 const error = new Error('private decoder message'); error.name = 'EncodingError';
 outputs.error(error);
 const failure = p.startupFailure();
 assert.match(failure, /received 1 video packets/);
 assert.match(failure, /EncodingError/);
 assert.doesNotMatch(failure, /private decoder message/);
 p.stop();
});
test('startup failure identifies decoded frames discarded by playback timing', async () => {
 const p = player(); await p.accept(message(1, 0)); await p.accept(message(2, 1, 1));
 let released = 0; outputs.output({timestamp: 1000000, close() { released++; }});
 outputs.output({timestamp: 0, close() { released++; }});
 assert.match(p.startupFailure(), /decoded 2 frames/);
 assert.match(p.startupFailure(), /discarded 1/);
 p.stop(); assert.equal(released, 2);
});

test('counts decoded frames cleared during recovery', async () => {
 const p = player(); await p.accept(message(1, 0)); await p.accept(message(2, 1, 1));
 let released = 0; outputs.output({ timestamp: 1_000_000, close() { released++; } });
 p.recover();
 assert.match(p.startupFailure(), /discarded 1/);
 p.stop(); assert.equal(released, 1);
});

test('logs the first keyframe NAL structure and compares SPS to configured codec', async () => {
 const diagnostics = []; const p = player((...entry) => diagnostics.push(entry));
 await p.accept(message(1, 0));
 const key = message(2, 1, 1); key.payload = Uint8Array.from([
  0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x28, 0x80, 0, 0, 1, 0x68, 0xce, 0x06,
  0, 0, 0, 1, 0x65, 0x88, 0x84,
 ]);
 await p.accept(key);
 const [level, event, detail] = diagnostics.find(([, name]) => name === 'H.264 keyframe structure');
 assert.equal(level, 'info'); assert.match(detail, /Annex-B yes/); assert.match(detail, /SPS\/PPS yes/);
 assert.match(detail, /IDR yes/); assert.match(detail, /does not match configured avc1\.42e01f/);
 assert.doesNotMatch(detail, /\b88?84\b/i); p.stop();
});

test('distinguishes synchronous decode rejection from decoder callback failure', async () => {
 const diagnostics = []; const p = player((...entry) => diagnostics.push(entry));
 await p.accept(message(1, 0)); const key = message(2, 1, 1);
 throwDecode = new DOMException('invalid access unit token=private-token', 'DataError'); await p.accept(key);
 let detail = diagnostics.find(([, event]) => event === 'H.264 decode() rejected chunk')?.[2];
 assert.match(detail, /DataError: invalid access unit/); assert.match(detail, /token=\[redacted\]/);
 throwDecode = undefined; outputs.error(new DOMException('decoder rejected access unit', 'DataError'));
 detail = diagnostics.find(([, event]) => event === 'H.264 decoder callback failed')?.[2];
 assert.match(detail, /DataError: decoder rejected access unit/);
 assert.doesNotMatch(detail, /private-token/); p.stop();
});
