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
 const starts: { offset: number; size: number }[] = [];
 for (let offset = findStartCode(bytes, 0); offset >= 0; offset = findStartCode(bytes, offset + startCodeSize(bytes, offset)))
  starts.push({ offset, size: startCodeSize(bytes, offset) });
 if (!starts.length) return `bytes ${bytes.length}; Annex-B no start code; SPS/PPS no; IDR no; key flag ${keyFlag ? 'yes' : 'no'}`;

 const nals: { type: number; length: number; spsCodec?: string }[] = [];
 for (let i = 0; i < starts.length; i++) {
  const start = starts[i]; const begin = start.offset + start.size;
  let end = i + 1 < starts.length ? starts[i + 1].offset : bytes.length;
  while (end > begin && bytes[end - 1] === 0) end--;
  if (begin >= end) continue;
  const type = bytes[begin] & 0x1f;
  const nal = { type, length: end - begin } as { type: number; length: number; spsCodec?: string };
  if (type === 7 && end - begin >= 4) nal.spsCodec = `avc1.${[bytes[begin + 1], bytes[begin + 2], bytes[begin + 3]].map(x => x.toString(16).padStart(2, '0')).join('')}`;
  nals.push(nal);
 }
 const names = new Map([[1, 'SLICE'], [5, 'IDR'], [6, 'SEI'], [7, 'SPS'], [8, 'PPS'], [9, 'AUD'], [10, 'END'], [11, 'END_STREAM'], [12, 'FILLER']]);
 const description = nals.slice(0, 12).map(nal => `${names.get(nal.type) ?? `NAL${nal.type}`}:${nal.length}`).join(',') || 'none';
 const extra = nals.length > 12 ? `,...+${nals.length - 12}` : '';
 const spsCodec = nals.find(nal => nal.spsCodec)?.spsCodec;
 const codecMatch = spsCodec ? spsCodec.toLowerCase() === codec.toLowerCase() : undefined;
 const codecDetail = spsCodec ? `SPS codec ${spsCodec} (${codecMatch ? 'matches configured codec' : `does not match configured ${codec}`})` : 'SPS codec unavailable';
 const annexB = starts[0].offset === 0 ? 'yes' : `no (${starts[0].offset} leading bytes)`;
 return `bytes ${bytes.length}; Annex-B ${annexB}; NALs ${description}${extra}; SPS/PPS ${nals.some(n => n.type === 7) && nals.some(n => n.type === 8) ? 'yes' : 'no'}; IDR ${nals.some(n => n.type === 5) ? 'yes' : 'no'}; key flag ${keyFlag ? 'yes' : 'no'}; ${codecDetail}`;
}
