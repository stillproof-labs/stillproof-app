// Reads a receipt embedded in a JPEG as a C2PA manifest store (SPEC.md §8.3),
// in the format of the Go reference (stillproof, package embed). Read-only: it
// finds the C2PA APP11 segments, reads the org.stillproof.receipt assertion of
// the active manifest, checks its c2pa.hash.data hard binding over the JPEG
// minus its exclusions, and gives back the bytes without those segments. It
// does not check the C2PA signature: the proof is the receipt, and §6 step 2
// hashes the bytes it returns.
//
// APP11 framing (ISO/IEC 19566-5, JPEG XT): FF EB, Lp (u16), CI "JP",
// En (u16), Z (u32, from 1), then box bytes. Every segment after the first
// repeats the box's LBox and TBox (and XLBox, if used).

import { sha256 } from '@noble/hashes/sha2.js';

export const RECEIPT_LABEL = 'org.stillproof.receipt';
export const DATA_HASH_LABEL = 'c2pa.hash.data';

/** JUMBF type UUIDs: four ASCII bytes and 0011-0010-8000-00AA00389B71. */
const uuid = (s: string) =>
  Array.from(s, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('') + '00110010800000aa00389b71';
const UUID_STORE = uuid('c2pa');
const UUID_ASSERTIONS = uuid('c2as');
const CBOR_FAIL_PREFIX = DATA_HASH_LABEL;

type DataHash = {
  exclusions: { start: number; length: number }[];
  alg: string;
  hash: Uint8Array;
};

type CborCursor = { b: Uint8Array; i: number };

export class C2paFormatError extends Error {
  name = 'C2paFormatError';
}

export type C2paRead =
  | { c2pa: false }
  | {
      c2pa: true;
      /** The receipt JSON, if the active manifest has a Stillproof assertion. */
      receipt?: string;
      /** The file with every C2PA APP11 segment removed. */
      original: Uint8Array;
    };

type Segment = { marker: number; start: number; data: number; end: number };
type Box = { type: string; body: Uint8Array };
type Superbox = { uuid: string; label?: string; content: Box[] };

const u16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const ascii = (b: Uint8Array) => String.fromCharCode(...b);
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function fail(why: string): never {
  throw new C2paFormatError(`C2PA: ${why}`);
}

function utf8(b: Uint8Array): string {
  try {
    return decodeURIComponent(Array.from(b, (x) => `%${x.toString(16).padStart(2, '0')}`).join(''));
  } catch {
    return fail('text is not UTF-8');
  }
}

/** The marker segments from SOI up to and including SOS, or undefined if the header is not well formed. */
function segments(b: Uint8Array): Segment[] | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  const out: Segment[] = [];
  for (let i = 2; ; ) {
    if (i >= b.length || b[i] !== 0xff) return undefined;
    const start = i;
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return undefined;
    const marker = b[i++];
    if (marker === 0xd9) return out; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push({ marker, start, data: i, end: i }); // TEM, RSTn: no length
      continue;
    }
    if (i + 2 > b.length) return undefined;
    const n = u16(b, i);
    if (n < 2 || i + n > b.length) return undefined;
    out.push({ marker, start, data: i + 2, end: i + n });
    i += n;
    if (marker === 0xda) return out; // SOS: the scan follows
  }
}

/** The C2PA store's segments and its reassembled JUMBF, as the Go reference finds them. */
function c2paSegments(b: Uint8Array, segs: Segment[]): { found: Segment[]; store: Uint8Array } {
  const found: Segment[] = [];
  const parts: Uint8Array[] = [];
  let en = -1;
  let z = 0;
  let repeat = 8;
  for (const s of segs) {
    const p = b.subarray(s.data, s.end);
    if (s.marker !== 0xeb || p.length < 16 || p[0] !== 0x4a || p[1] !== 0x50) continue;
    const seq = u32(p, 4);
    if (en >= 0 && u16(p, 2) === en) {
      if (seq !== z + 1) fail('APP11 segments out of sequence');
      z = seq;
      found.push(s);
      parts.push(p.subarray(8 + repeat));
      continue;
    }
    if (p.length >= 28 && ascii(p.subarray(12, 16)) === 'jumb' && ascii(p.subarray(24, 28)) === 'c2pa') {
      if (en >= 0) fail('more than one manifest store');
      if (seq !== 1) fail('APP11 segments out of sequence');
      [en, z] = [u16(p, 2), seq];
      repeat = u32(p, 8) === 1 ? 16 : 8;
      found.push(s);
      parts.push(p.subarray(8));
    }
  }
  const store = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) {
    store.set(x, o);
    o += x.length;
  }
  return { found, store };
}

function boxes(b: Uint8Array): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < b.length; ) {
    if (i + 8 > b.length) fail('truncated box');
    let len = u32(b, i);
    let h = 8;
    if (len === 0) len = b.length - i;
    else if (len === 1) {
      if (i + 16 > b.length || u32(b, i + 8) !== 0) fail('box too large');
      [len, h] = [u32(b, i + 12), 16];
    }
    if (len < h || i + len > b.length) fail('bad box length');
    out.push({ type: ascii(b.subarray(i + 4, i + 8)), body: b.subarray(i + h, i + len) });
    i += len;
  }
  return out;
}

function superbox(box: Box): Superbox {
  if (box.type !== 'jumb') fail('expected a jumb box');
  const [desc, ...content] = boxes(box.body);
  if (desc?.type !== 'jumd' || desc.body.length < 17) fail('jumb without jumd');
  const d = desc.body;
  let label: string | undefined;
  if (d[16] & 0x02) {
    const nul = d.indexOf(0, 17);
    if (nul < 0) fail('unterminated label');
    label = utf8(d.subarray(17, nul));
  }
  return { uuid: hex(d.subarray(0, 16)), label, content };
}

const children = (j: Superbox) => j.content.filter((c) => c.type === 'jumb').map(superbox);

function cborFail(why: string): never {
  return fail(`${CBOR_FAIL_PREFIX}: ${why}`);
}

function need(c: CborCursor, n: number): void {
  if (c.i + n > c.b.length) cborFail('truncated cbor');
}

function readUintBig(c: CborCursor, ai: number): bigint {
  if (ai < 24) return BigInt(ai);
  if (ai === 24) {
    need(c, 1);
    return BigInt(c.b[c.i++]);
  }
  if (ai === 25) {
    need(c, 2);
    const v = u16(c.b, c.i);
    c.i += 2;
    return BigInt(v);
  }
  if (ai === 26) {
    need(c, 4);
    const v = u32(c.b, c.i);
    c.i += 4;
    return BigInt(v);
  }
  if (ai === 27) {
    need(c, 8);
    const hi = BigInt(u32(c.b, c.i));
    const lo = BigInt(u32(c.b, c.i + 4));
    c.i += 8;
    return (hi << 32n) | lo;
  }
  return cborFail('unsupported cbor length');
}

function toSafeInt(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) cborFail('integer out of range');
  return Number(n);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, ch) => n + ch.length, 0));
  let o = 0;
  for (const ch of chunks) {
    out.set(ch, o);
    o += ch.length;
  }
  return out;
}

function readCborBytes(c: CborCursor, majorExpected: 2 | 3, ai: number): Uint8Array {
  if (ai !== 31) {
    const len = toSafeInt(readUintBig(c, ai));
    need(c, len);
    const slice = c.b.subarray(c.i, c.i + len);
    c.i += len;
    return slice;
  }
  const chunks: Uint8Array[] = [];
  for (;;) {
    need(c, 1);
    if (c.b[c.i] === 0xff) {
      c.i++;
      return concatChunks(chunks);
    }
    const init = c.b[c.i++];
    const major = init >> 5;
    const chunkAi = init & 0x1f;
    if (major !== majorExpected || chunkAi === 31) cborFail('bad indefinite string chunk');
    chunks.push(readCborBytes(c, majorExpected, chunkAi));
  }
}

function readCborValue(c: CborCursor, depth = 0): unknown {
  if (depth > 16) cborFail('nesting too deep');
  need(c, 1);
  const init = c.b[c.i++];
  const major = init >> 5;
  const ai = init & 0x1f;

  switch (major) {
    case 0:
      return toSafeInt(readUintBig(c, ai));
    case 1:
      return -1 - toSafeInt(readUintBig(c, ai));
    case 2:
      return readCborBytes(c, 2, ai);
    case 3:
      return utf8(readCborBytes(c, 3, ai));
    case 4: {
      const arr: unknown[] = [];
      if (ai === 31) {
        for (;;) {
          need(c, 1);
          if (c.b[c.i] === 0xff) {
            c.i++;
            return arr;
          }
          arr.push(readCborValue(c, depth + 1));
        }
      }
      const len = toSafeInt(readUintBig(c, ai));
      if (len > c.b.length - c.i) cborFail('truncated cbor');
      for (let k = 0; k < len; k++) arr.push(readCborValue(c, depth + 1));
      return arr;
    }
    case 5: {
      const map = new Map<unknown, unknown>();
      if (ai === 31) {
        for (;;) {
          need(c, 1);
          if (c.b[c.i] === 0xff) {
            c.i++;
            return map;
          }
          const k = readCborValue(c, depth + 1);
          const v = readCborValue(c, depth + 1);
          map.set(k, v);
        }
      }
      const len = toSafeInt(readUintBig(c, ai));
      if (len * 2 > c.b.length - c.i) cborFail('truncated cbor');
      for (let k = 0; k < len; k++) {
        const key = readCborValue(c, depth + 1);
        const val = readCborValue(c, depth + 1);
        map.set(key, val);
      }
      return map;
    }
    case 6:
      readUintBig(c, ai);
      return readCborValue(c, depth + 1);
    case 7:
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return undefined;
      if (ai === 24) {
        need(c, 1);
        return c.b[c.i++];
      }
      if (ai === 25) {
        need(c, 2);
        c.i += 2;
        return NaN;
      }
      if (ai === 26) {
        need(c, 4);
        const v = new DataView(c.b.buffer, c.b.byteOffset + c.i, 4).getFloat32(0);
        c.i += 4;
        return v;
      }
      if (ai === 27) {
        need(c, 8);
        const v = new DataView(c.b.buffer, c.b.byteOffset + c.i, 8).getFloat64(0);
        c.i += 8;
        return v;
      }
      return cborFail('unsupported cbor simple value');
    default:
      return cborFail('unexpected cbor major type');
  }
}

function parseDataHash(raw: Uint8Array): DataHash {
  const c: CborCursor = { b: raw, i: 0 };
  const top = readCborValue(c);
  if (c.i !== raw.length) cborFail('trailing bytes');
  if (!(top instanceof Map)) cborFail('expected a map');

  const exclusions: { start: number; length: number }[] = [];
  const rawExclusions = top.get('exclusions');
  if (rawExclusions !== undefined && rawExclusions !== null) {
    if (!Array.isArray(rawExclusions)) cborFail('exclusions must be an array');
    for (const item of rawExclusions) {
      if (!(item instanceof Map)) cborFail('exclusion must be a map');
      const start = item.get('start') ?? 0;
      const length = item.get('length') ?? 0;
      if (typeof start !== 'number' || !Number.isSafeInteger(start) || typeof length !== 'number' || !Number.isSafeInteger(length)) {
        cborFail('bad exclusion');
      }
      exclusions.push({ start, length });
    }
  }

  const rawAlg = top.get('alg');
  let alg = '';
  if (rawAlg !== undefined && rawAlg !== null) {
    if (typeof rawAlg !== 'string') cborFail('alg must be a string');
    alg = rawAlg;
  }

  const hash = top.get('hash');
  if (!(hash instanceof Uint8Array)) cborFail('hash must be bytes');

  return { exclusions, alg, hash };
}

function checkDataHash(jpeg: Uint8Array, dh: DataHash): void {
  if (dh.alg !== '' && dh.alg !== 'sha256') {
    cborFail(`unsupported alg ${JSON.stringify(dh.alg)}`);
  }
  const h = sha256.create();
  let from = 0;
  for (const x of dh.exclusions) {
    if (x.start < from || x.length < 0 || x.start > jpeg.length - x.length) {
      cborFail('bad exclusion');
    }
    h.update(jpeg.subarray(from, x.start));
    from = x.start + x.length;
  }
  h.update(jpeg.subarray(from));
  const sum = h.digest();
  if (sum.length !== dh.hash.length || !sum.every((b, i) => b === dh.hash[i])) {
    fail('the JPEG does not match its C2PA hard binding (c2pa.hash.data)');
  }
}

/** The receipt JSON and data hash assertion in the active (last) manifest, if present. */
function readManifest(store: Uint8Array): { receipt?: string; dataHash?: DataHash } {
  const top = boxes(store);
  if (top.length !== 1) fail('expected one manifest store box');
  const sb = superbox(top[0]);
  const manifests = children(sb);
  if (sb.uuid !== UUID_STORE || manifests.length === 0) fail('no manifest in the store');
  let receipt: string | undefined;
  let hashCbor: Uint8Array | undefined;
  for (const part of children(manifests[manifests.length - 1])) {
    if (part.uuid !== UUID_ASSERTIONS) continue;
    for (const a of children(part)) {
      if (a.label === RECEIPT_LABEL) {
        const json = a.content.find((c) => c.type === 'json');
        if (!json) fail(`${RECEIPT_LABEL} has no json box`);
        receipt = utf8(json.body);
      } else if (a.label === DATA_HASH_LABEL) {
        const cbor = a.content.find((c) => c.type === 'cbor');
        if (!cbor) fail(`${DATA_HASH_LABEL} has no cbor box`);
        hashCbor = cbor.body;
      }
    }
  }
  if (receipt !== undefined && hashCbor === undefined) {
    fail(`the C2PA manifest has no ${DATA_HASH_LABEL} assertion`);
  }
  return { receipt, dataHash: hashCbor ? parseDataHash(hashCbor) : undefined };
}

/**
 * Reads the C2PA manifest store in a JPEG. Returns { c2pa: false } for a file
 * that is not a well-formed JPEG or has no store. Throws C2paFormatError if
 * the store is malformed or its c2pa.hash.data binding fails.
 */
export function readC2pa(bytes: Uint8Array): C2paRead {
  const segs = segments(bytes);
  if (!segs) return { c2pa: false };
  const { found, store } = c2paSegments(bytes, segs);
  if (found.length === 0) return { c2pa: false };
  const { receipt, dataHash } = readManifest(store);
  if (dataHash) checkDataHash(bytes, dataHash);

  const original = new Uint8Array(bytes.length - found.reduce((n, s) => n + s.end - s.start, 0));
  let from = 0;
  let o = 0;
  for (const s of found) {
    original.set(bytes.subarray(from, s.start), o);
    o += s.start - from;
    from = s.end;
  }
  original.set(bytes.subarray(from), o);
  return { c2pa: true, receipt, original };
}
