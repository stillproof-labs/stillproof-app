import { utf8ToBytes } from '@noble/hashes/utils.js';

import { C2paFormatError, readC2pa } from '../c2pa';
import { parseReceipt } from '../receipt';
import { fixtureBytes, fixtureText } from '../__fixtures__/c2pa';
import { C2AS, C2MA, C2PA, CBOR_UUID, JSON_UUID, app11, box, embed, embedReceipt, jpeg, manifestStore, superbox } from '../__fixtures__/jumbf';

const RECEIPT = JSON.stringify({ v: 1, note: 'any receipt json, ünïcode' });

it('reads the receipt and strips the segments back to the original bytes', () => {
  const original = jpeg();
  const r = readC2pa(embedReceipt(original, RECEIPT).bytes);
  expect(r).toEqual({ c2pa: true, receipt: RECEIPT, original });
});

it('joins a box split over many segments', () => {
  const original = jpeg();
  const big = RECEIPT.padEnd(5000, ' ');
  const { bytes, segments } = embedReceipt(original, big, { en: 7, chunk: 100 });
  expect(segments.length).toBeGreaterThan(40);
  expect(readC2pa(bytes)).toEqual({ c2pa: true, receipt: big, original });
});

it('uses the last (active) manifest', () => {
  const old = superbox(JSON_UUID, 'org.stillproof.receipt', box('json', utf8ToBytes('"old"')));
  const older = superbox(C2MA, 'urn:uuid:old', superbox(C2AS, 'c2pa.assertions', old));
  const r = readC2pa(embedReceipt(jpeg(), RECEIPT, { extraManifests: [older] }).bytes);
  expect(r).toMatchObject({ c2pa: true, receipt: RECEIPT });
});

it('strips a manifest store without a Stillproof assertion and reports no receipt', () => {
  const original = jpeg();
  const r = readC2pa(embed(original, app11(superbox(C2PA, 'c2pa', superbox(C2MA, 'm')))));
  expect(r).toEqual({ c2pa: true, receipt: undefined, original });
});

it('keeps APP11 JUMBF segments that are not C2PA', () => {
  const other = app11(superbox('00112233445566778899aabbccddeeff', 'jpeg-xt'), 2);
  const withOther = embed(jpeg(), other);
  expect(readC2pa(withOther)).toEqual({ c2pa: false });
  const both = embedReceipt(withOther, RECEIPT, { en: 1 }).bytes;
  expect(readC2pa(both)).toEqual({ c2pa: true, receipt: RECEIPT, original: withOther });
});

it('ignores files without C2PA and files that are not JPEGs', () => {
  expect(readC2pa(jpeg())).toEqual({ c2pa: false });
  expect(readC2pa(utf8ToBytes('not a jpeg'))).toEqual({ c2pa: false });
  expect(readC2pa(new Uint8Array())).toEqual({ c2pa: false });
});

it('throws on a malformed store', () => {
  const noJson = superbox(C2PA, 'c2pa', superbox(C2MA, 'm', superbox(C2AS, 'c2pa.assertions', superbox(JSON_UUID, 'org.stillproof.receipt', box('bfdb', Uint8Array.of(1))))));
  expect(() => readC2pa(embed(jpeg(), app11(noJson)))).toThrow(C2paFormatError);
  const segs = app11(manifestStore(RECEIPT.padEnd(500)), 1, 100);
  expect(() => readC2pa(embed(jpeg(), [segs[0], ...segs.slice(2)]))).toThrow('out of sequence');
  const two = embed(embed(jpeg(), app11(manifestStore(RECEIPT), 1)), app11(manifestStore(RECEIPT), 2));
  expect(() => readC2pa(two)).toThrow('more than one');
  expect(() => readC2pa(embed(jpeg(), app11(manifestStore(RECEIPT))))).toThrow(C2paFormatError);
});

describe('c2pa.hash.data hard binding', () => {
  it('accepts an omitted alg as sha256', () => {
    const original = jpeg();
    const { bytes } = embedReceipt(original, RECEIPT, { alg: '' });
    expect(readC2pa(bytes)).toEqual({ c2pa: true, receipt: RECEIPT, original });
  });

  it('rejects a byte flipped outside the APP11 segments', () => {
    const tampered = embedReceipt(jpeg(), RECEIPT).bytes;
    tampered[tampered.length - 5] ^= 0xff;
    expect(() => readC2pa(tampered)).toThrow(C2paFormatError);
  });

  it('rejects an unsupported alg', () => {
    const { bytes } = embedReceipt(jpeg(), RECEIPT, { alg: 'sha512' });
    expect(() => readC2pa(bytes)).toThrow(C2paFormatError);
  });

  it('rejects out-of-range, negative, and out-of-order exclusions', () => {
    const orig = jpeg();
    expect(() => readC2pa(embedReceipt(orig, RECEIPT, { exclusions: [{ start: orig.length + 1000, length: 4 }] }).bytes)).toThrow(C2paFormatError);
    expect(() => readC2pa(embedReceipt(orig, RECEIPT, { exclusions: [{ start: 10, length: -1 }] }).bytes)).toThrow(C2paFormatError);
    expect(() =>
      readC2pa(
        embedReceipt(orig, RECEIPT, {
          exclusions: [
            { start: 20, length: 10 },
            { start: 25, length: 5 },
          ],
        }).bytes,
      ),
    ).toThrow(C2paFormatError);
  });

  it('rejects malformed c2pa.hash.data cbor box', () => {
    const badCbor = superbox(
      C2PA,
      'c2pa',
      superbox(
        C2MA,
        'm',
        superbox(
          C2AS,
          'c2pa.assertions',
          superbox(JSON_UUID, 'org.stillproof.receipt', box('json', utf8ToBytes(RECEIPT))),
          superbox(CBOR_UUID, 'c2pa.hash.data', box('cbor', Uint8Array.of(0x1f))),
        ),
      ),
    );
    expect(() => readC2pa(embed(jpeg(), app11(badCbor)))).toThrow(C2paFormatError);
  });
});

// Written by the Go reference, `stillproof embed` (see __fixtures__/c2pa/gen.go.txt).
describe('files from the Go embed package', () => {
  const fixture = fixtureBytes;
  const original = fixture('original.jpg');
  const receipt = parseReceipt(fixtureText('receipt.json'));

  it('reads the receipt and gives back the exact original bytes', () => {
    const r = readC2pa(fixture('embedded.jpg'));
    if (!r.c2pa) throw new Error('no C2PA found');
    expect(r.original).toEqual(original);
    expect(parseReceipt(r.receipt!)).toEqual(receipt);
  });

  it('rejects a Go fixture with a flipped byte outside APP11', () => {
    const tampered = new Uint8Array(fixture('embedded.jpg'));
    tampered[tampered.length - 5] ^= 0x01;
    expect(() => readC2pa(tampered)).toThrow(C2paFormatError);
  });

  it('joins a store split over two APP11 segments', () => {
    const r = readC2pa(fixture('embedded-attested.jpg'));
    if (!r.c2pa) throw new Error('no C2PA found');
    expect(r.original).toEqual(original);
    const got = parseReceipt(r.receipt!);
    expect(got).toMatchObject({ ...receipt, attestation: { kind: 'android-key' } });
    expect(got.attestation).toMatchObject({ chain: [expect.any(String), expect.any(String)] });
  });

  it('finds nothing in the original', () => {
    expect(readC2pa(original)).toEqual({ c2pa: false });
  });
});
