// Test-only writer for C2PA APP11 JUMBF segments, per ISO/IEC 19566-5. Files
// written by the Go reference itself are in ./c2pa.
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const C2PA = '6332706100110010800000aa00389b71';
export const C2MA = '63326d6100110010800000aa00389b71';
export const C2AS = '6332617300110010800000aa00389b71';
export const JSON_UUID = '6a736f6e00110010800000aa00389b71';
export const CBOR_UUID = '63626f7200110010800000aa00389b71';

export function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const be = (n: number, w: number) => Uint8Array.from({ length: w }, (_, i) => (n >>> (8 * (w - 1 - i))) & 0xff);

export const box = (type: string, body: Uint8Array) => cat(be(8 + body.length, 4), utf8ToBytes(type), body);

export const superbox = (uuid: string, label: string, ...content: Uint8Array[]) =>
  box('jumb', cat(box('jumd', cat(hexToBytes(uuid), Uint8Array.of(0x03), utf8ToBytes(label), Uint8Array.of(0))), ...content));

function cborHead(major: number, n: number): Uint8Array {
  const m = major << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 0x100) return Uint8Array.of(m | 24, n);
  if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 0xff);
  return cat(Uint8Array.of(m | 26), be(n, 4));
}

export function cborEncode(v: unknown): Uint8Array {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (v instanceof Uint8Array) return cat(cborHead(2, v.length), v);
  if (typeof v === 'string') {
    const b = utf8ToBytes(v);
    return cat(cborHead(3, b.length), b);
  }
  if (Array.isArray(v)) return cat(cborHead(4, v.length), ...v.map(cborEncode));
  if (v && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, val]) => val !== undefined);
    return cat(cborHead(5, entries.length), ...entries.flatMap(([k, val]) => [cborEncode(k), cborEncode(val)]));
  }
  throw new Error(`unsupported test CBOR value: ${String(v)}`);
}

export type DataHashSpec = {
  exclusions: { start: number; length: number }[];
  alg?: string;
  hash: Uint8Array;
};

/** A manifest store whose active (last) manifest has the receipt assertion (and optional c2pa.hash.data). */
export function manifestStore(receiptJson: string, extraManifests: Uint8Array[] = [], dataHash?: DataHashSpec): Uint8Array {
  const assertions = [superbox(JSON_UUID, 'org.stillproof.receipt', box('json', utf8ToBytes(receiptJson)))];
  if (dataHash) {
    assertions.push(
      superbox(
        CBOR_UUID,
        'c2pa.hash.data',
        box('cbor', cborEncode({ exclusions: dataHash.exclusions, alg: dataHash.alg, hash: dataHash.hash })),
      ),
    );
  }
  const manifest = superbox(C2MA, 'urn:uuid:00000000-0000-4000-8000-000000000000', superbox(C2AS, 'c2pa.assertions', ...assertions));
  return superbox(C2PA, 'c2pa', ...extraManifests, manifest);
}

/** Inserts a manifest store after APP0 with a converging c2pa.hash.data exclusion over the inserted APP11 bytes. */
export function embedReceipt(
  original: Uint8Array,
  receiptJson: string,
  opts: {
    en?: number;
    chunk?: number;
    extraManifests?: Uint8Array[];
    alg?: string;
    exclusions?: { start: number; length: number }[];
    hash?: Uint8Array;
  } = {},
): { bytes: Uint8Array; segments: Uint8Array[] } {
  const pos = 2 + 2 + ((original[4] << 8) | original[5]);
  const hash = opts.hash ?? sha256(original);
  let len = 0;
  for (let i = 0; i < 8; i++) {
    const segs = app11(
      manifestStore(receiptJson, opts.extraManifests, {
        exclusions: opts.exclusions ?? [{ start: pos, length: len }],
        alg: opts.alg === undefined ? 'sha256' : opts.alg || undefined,
        hash,
      }),
      opts.en,
      opts.chunk,
    );
    const total = segs.reduce((n, s) => n + s.length, 0);
    if (total === len || opts.exclusions !== undefined) {
      return { bytes: embed(original, segs), segments: segs };
    }
    len = total;
  }
  throw new Error('dataHash exclusion length did not settle');
}

/** APP11 segments for one JUMBF box, splitting it every `chunk` payload bytes. */
export function app11(jumbf: Uint8Array, en = 1, chunk = 65000): Uint8Array[] {
  const header = jumbf.subarray(0, 8);
  const segs: Uint8Array[] = [];
  for (let off = 0, z = 1; off < jumbf.length; z++) {
    const take = off === 0 ? jumbf.subarray(0, chunk) : cat(header, jumbf.subarray(off, off + chunk));
    off += off === 0 ? Math.min(chunk, jumbf.length) : Math.min(chunk, jumbf.length - off);
    const body = cat(utf8ToBytes('JP'), be(en, 2), be(z, 4), take);
    segs.push(cat(Uint8Array.of(0xff, 0xeb), be(body.length + 2, 2), body));
  }
  return segs;
}

/** A minimal JPEG: SOI, APP0, DQT, SOS with some scan bytes, EOI. */
export function jpeg(): Uint8Array {
  const seg = (m: number, body: number[]) => Uint8Array.of(0xff, m, ...be(body.length + 2, 2), ...body);
  return cat(
    Uint8Array.of(0xff, 0xd8),
    seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    seg(0xdb, Array.from({ length: 65 }, (_, i) => i)),
    seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    // Scan data, including bytes that look like an APP11 marker.
    Uint8Array.of(0x12, 0xff, 0x00, 0xff, 0xeb, 0x00, 0x04, 0x4a, 0x50, 0x99),
    Uint8Array.of(0xff, 0xd9),
  );
}

/** Inserts segments after APP0, as an embedder would. */
export function embed(original: Uint8Array, segments: Uint8Array[]): Uint8Array {
  const afterApp0 = 2 + 2 + ((original[4] << 8) | original[5]);
  return cat(original.subarray(0, afterApp0), ...segments, original.subarray(afterApp0));
}
