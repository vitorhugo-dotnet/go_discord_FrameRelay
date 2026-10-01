import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeH264AccessUnit } from '../src/h264-diagnostics.ts';
import { maxMessageSize } from '../src/media-protocol.ts';

test('summarizes Annex-B keyframe structure without exposing encoded bytes', () => {
 const accessUnit = Uint8Array.from([
  0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x28, 0x80,
  0, 0, 1, 0x68, 0xce, 0x06,
  0, 0, 0, 1, 0x65, 0x88, 0x84,
 ]);

 const summary = summarizeH264AccessUnit(accessUnit, 'avc1.42c028', true);

 assert.match(summary, /Annex-B yes/);
 assert.match(summary, /SPS:5,PPS:3,IDR:3/);
 assert.match(summary, /IDR yes/);
 assert.match(summary, /SPS\/PPS yes/);
 assert.match(summary, /SPS codec avc1\.42c028 \(matches configured codec\)/);
 assert.doesNotMatch(summary, /0x65|0x88|0x84/i);
});

test('reports leading bytes, absent IDR, and SPS codec mismatch', () => {
 const accessUnit = Uint8Array.from([9, 9, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0x80,
  0, 0, 1, 0x68, 0xce]);

 const summary = summarizeH264AccessUnit(accessUnit, 'avc1.42c028', true);

 assert.match(summary, /Annex-B no \(2 leading bytes\)/);
 assert.match(summary, /IDR no/);
 assert.match(summary, /SPS codec avc1\.42e01f \(does not match configured avc1\.42c028\)/);
});

test('identifies missing Annex-B start codes and parameter sets', () => {
 const summary = summarizeH264AccessUnit(Uint8Array.from([0x65, 0x88, 0x84]), 'avc1.42c028', true);

 assert.match(summary, /Annex-B no start code/);
 assert.match(summary, /SPS\/PPS no/);
 assert.match(summary, /IDR no/);
});

test('summarizes an 8 MiB access unit with bounded detail retention', () => {
 const payload = new Uint8Array(maxMessageSize - 40);
 for (let offset = 0; offset < payload.length; offset += 4) payload.set([0, 0, 1, 0x65], offset);

 const summary = summarizeH264AccessUnit(payload, 'avc1.42c028', true);

 assert.match(summary, /NALs IDR:1(?:,IDR:1){11},\.\.\.\+2097130/);
 assert.ok(summary.length < 512);
});
