import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeMediaMessage, decodeMediaMessage } from '../src/media-protocol.ts';
const vectors = JSON.parse(readFileSync(new URL('../../docs/protocol/discord-media-v1-vectors.json', import.meta.url)));
for (const vector of vectors) test(vector.name, () => {
 const wire = Uint8Array.from(Buffer.from(vector.hex, 'hex'));
 if (vector.invalid) { assert.throws(() => decodeMediaMessage(wire)); return; }
 const m = decodeMediaMessage(wire); assert.deepEqual(encodeMediaMessage(m), wire);
 assert.equal(m.type, vector.type); assert.equal(m.timestampUs, vector.timestampUs);
});
test('unsafe time and oversize rejected', () => {
 const sample = { type: 2, flags: 1, generation: 1, sequence: 0, timestampUs: 0, durationUs: 0, payload: new Uint8Array() };
 assert.throws(() => encodeMediaMessage({ ...sample, timestampUs: Number.MAX_SAFE_INTEGER + 1 }));
 assert.throws(() => encodeMediaMessage({ ...sample, payload: new Uint8Array(8 * 1024 * 1024) }));
});
