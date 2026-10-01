function startCodeSize(bytes: Uint8Array, offset: number): number {
 if (offset + 3 <= bytes.length && bytes[offset] === 0 && bytes[offset + 1] === 0 && bytes[offset + 2] === 1) return 3;
 if (offset + 4 <= bytes.length && bytes[offset] === 0 && bytes[offset + 1] === 0
  && bytes[offset + 2] === 0 && bytes[offset + 3] === 1) return 4;
 return 0;
}

function findStartCode(bytes: Uint8Array, from: number): number {
 for (let i = from; i + 3 <= bytes.length; i++) if (startCodeSize(bytes, i)) return i;
 return -1;
}

export function summarizeH264AccessUnit(bytes: Uint8Array, codec: string, keyFlag: boolean): string {
 const descriptions: string[] = [];
 let nalCount = 0; let hasSps = false; let hasPps = false; let hasIdr = false; let spsCodec: string | undefined;
 let firstStart = -1; let nalStart = -1;
 const names = new Map([[1, 'SLICE'], [5, 'IDR'], [6, 'SEI'], [7, 'SPS'], [8, 'PPS'], [9, 'AUD'], [10, 'END'], [11, 'END_STREAM'], [12, 'FILLER']]);
 const consumeNal = (begin: number, rawEnd: number) => {
  let end = rawEnd;
  while (end > begin && bytes[end - 1] === 0) end--;
  if (begin >= end) return;
  const type = bytes[begin] & 0x1f;
  nalCount++;
  if (type === 7) {
   hasSps = true;
   if (!spsCodec && end - begin >= 4) spsCodec = `avc1.${[bytes[begin + 1], bytes[begin + 2], bytes[begin + 3]].map(x => x.toString(16).padStart(2, '0')).join('')}`;
  } else if (type === 8) hasPps = true;
  else if (type === 5) hasIdr = true;
  if (descriptions.length < 12) descriptions.push(`${names.get(type) ?? `NAL${type}`}:${end - begin}`);
 };
 for (let offset = findStartCode(bytes, 0); offset >= 0;) {
  const size = startCodeSize(bytes, offset);
  if (firstStart < 0) firstStart = offset;
  if (nalStart >= 0) consumeNal(nalStart, offset);
  nalStart = offset + size;
  offset = findStartCode(bytes, nalStart);
 }
 if (firstStart < 0) return `bytes ${bytes.length}; Annex-B no start code; SPS/PPS no; IDR no; key flag ${keyFlag ? 'yes' : 'no'}`;
 consumeNal(nalStart, bytes.length);
 const description = descriptions.join(',') || 'none';
 const extra = nalCount > descriptions.length ? `,...+${nalCount - descriptions.length}` : '';
 const codecMatch = spsCodec ? spsCodec.toLowerCase() === codec.toLowerCase() : undefined;
 const codecDetail = spsCodec ? `SPS codec ${spsCodec} (${codecMatch ? 'matches configured codec' : `does not match configured ${codec}`})` : 'SPS codec unavailable';
 const annexB = firstStart === 0 ? 'yes' : `no (${firstStart} leading bytes)`;
 return `bytes ${bytes.length}; Annex-B ${annexB}; NALs ${description}${extra}; SPS/PPS ${hasSps && hasPps ? 'yes' : 'no'}; IDR ${hasIdr ? 'yes' : 'no'}; key flag ${keyFlag ? 'yes' : 'no'}; ${codecDetail}`;
}
