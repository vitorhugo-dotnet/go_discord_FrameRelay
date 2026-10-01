export interface MediaMessage {
 type: number; flags: number; generation: number; sequence: number;
 timestampUs: number; durationUs: number; payload: Uint8Array;
}
export interface MediaConfiguration {
 video: { codec: string; width: number; height: number; format: 'annexb' };
 audio: { codec: 'opus'; sampleRate: number; channels: number } | null;
}
export const maxMessageSize = 8 * 1024 * 1024;
function validate(m: MediaMessage) {
 if (!Number.isInteger(m.type) || m.type < 1 || m.type > 4 || !Number.isInteger(m.flags) || m.flags < 0 || m.flags > 1
  || (m.flags !== 0 && m.type !== 2) || !Number.isInteger(m.generation) || m.generation < 1 || m.generation > 0xffffffff
  || !Number.isInteger(m.sequence) || m.sequence < 0 || m.sequence > 0xffffffff
  || !Number.isSafeInteger(m.timestampUs) || m.timestampUs < 0 || !Number.isSafeInteger(m.durationUs) || m.durationUs < 0
  || m.payload.length > maxMessageSize - 40 || (m.type === 4 && m.payload.length !== 0)) throw new Error('Invalid media message');
}
export function encodeMediaMessage(m: MediaMessage): Uint8Array {
 validate(m); const bytes = new Uint8Array(40 + m.payload.length); const v = new DataView(bytes.buffer);
 bytes.set([70, 82, 77, 49, 1, m.type]); v.setUint16(6, m.flags, true); v.setUint32(8, m.generation, true);
 v.setUint32(12, m.sequence, true); v.setUint32(16, m.payload.length, true);
 v.setBigInt64(24, BigInt(m.timestampUs), true); v.setBigInt64(32, BigInt(m.durationUs), true);
 bytes.set(m.payload, 40); return bytes;
}
export function decodeMediaMessage(bytes: Uint8Array): MediaMessage {
 if (bytes.length < 40 || bytes.length > maxMessageSize) throw new Error('Invalid media length');
 const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
 if (v.getUint32(0, false) !== 0x46524d31 || bytes[4] !== 1 || v.getUint32(20, true) !== 0
  || v.getUint32(16, true) !== bytes.length - 40) throw new Error('Invalid media header');
 const m = { type: bytes[5], flags: v.getUint16(6, true), generation: v.getUint32(8, true), sequence: v.getUint32(12, true),
  timestampUs: Number(v.getBigInt64(24, true)), durationUs: Number(v.getBigInt64(32, true)), payload: bytes.subarray(40) };
 validate(m); return m;
}
export function decodeConfiguration(bytes: Uint8Array): MediaConfiguration {
 const c = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as MediaConfiguration;
 if (!c.video || !/^avc1\.[a-fA-F0-9]{6}$/.test(c.video.codec) || c.video.format !== 'annexb'
  || !Number.isInteger(c.video.width) || !Number.isInteger(c.video.height)
  || c.video.width < 1 || c.video.width > 8192 || c.video.height < 1 || c.video.height > 8192
  || (c.audio !== null && (!c.audio || c.audio.codec !== 'opus' || c.audio.sampleRate !== 48000 || ![1, 2].includes(c.audio.channels))))
  throw new Error('Invalid media configuration');
 return c;
}
