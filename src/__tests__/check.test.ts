import { p256 } from '@noble/curves/nist.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { lookupReceipts } from '../api';
import { checkPhoto } from '../check';
import { C2paFormatError } from '../protocol/c2pa';
import { buildClaim, leafHash, sha256Hex, signClaim, signedText, softwareSigner } from '../protocol/claim';
import { parseReceipt, verdictLines, type FetchTx, type Receipt } from '../protocol/receipt';
import { fixtureBytes, fixtureText } from '../protocol/__fixtures__/c2pa';
import { C2MA, C2PA, app11, embed, embedReceipt, jpeg, superbox } from '../protocol/__fixtures__/jumbf';
import vectors from '../protocol/__fixtures__/vectors.json';

jest.mock('expo-secure-store', () => ({ getItemAsync: async () => null }));

const ACCOUNT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const TX = 'b'.repeat(64);
const CLOSED_AT = '2026-11-05T12:00:00Z';

/** A one-leaf receipt for photo, signed with the vectors' key. */
async function receiptFor(photo: Uint8Array): Promise<Receipt> {
  const priv = hexToBytes(vectors.private_key);
  const key = bytesToHex(p256.getPublicKey(priv, false));
  const signed = signedText(await signClaim(buildClaim(photo, 'image/jpeg', 1762300800000n, key), softwareSigner(priv)));
  return {
    v: 1,
    claim: signed,
    index: 0,
    size: 1,
    proof: [],
    root: bytesToHex(leafHash(signed)),
    anchor: { network: 'testnet', account: ACCOUNT, tx: TX, ledger: 77, closed_at: CLOSED_AT },
  };
}

const fetchTxFor =
  (r: Receipt): FetchTx =>
  async (_, hash) =>
    hash !== TX
      ? null
      : {
          successful: true,
          source_account: ACCOUNT,
          memo_type: 'hash',
          memo: btoa(String.fromCharCode(...hexToBytes(r.root))),
          ledger: 77,
          created_at: CLOSED_AT,
        };

const respond = (status: number, body: unknown = {}) =>
  jest.fn(async (_url: string) => new Response(JSON.stringify(body), { status })) as unknown as jest.Mock &
    typeof fetch;

describe('lookupReceipts', () => {
  const hash = 'c'.repeat(64);

  it('asks the service by hash and parses every receipt', async () => {
    const r = await receiptFor(jpeg());
    const f = respond(200, { receipts: [r, r] });
    const got = await lookupReceipts(hash, f);
    expect(f).toHaveBeenCalledWith(`http://10.0.2.2:8080/v1/receipts?sha256=${hash}`);
    expect(got).toEqual({ status: 'found', receipts: [{ receipt: r, json: JSON.stringify(r) }, { receipt: r, json: JSON.stringify(r) }] });
  });

  it('maps 404 and an empty list to none, 202 to pending', async () => {
    await expect(lookupReceipts(hash, respond(404))).resolves.toEqual({ status: 'none' });
    await expect(lookupReceipts(hash, respond(200, { receipts: [] }))).resolves.toEqual({ status: 'none' });
    await expect(lookupReceipts(hash, respond(202, { status: 'pending' }))).resolves.toEqual({ status: 'pending' });
  });

  it('throws on server errors and malformed receipts', async () => {
    await expect(lookupReceipts(hash, respond(500))).rejects.toThrow('500');
    await expect(lookupReceipts(hash, respond(200, {}))).rejects.toThrow();
    await expect(lookupReceipts(hash, respond(200, { receipts: [{ v: 0 }] }))).rejects.toThrow('receipt');
  });
});

describe('checkPhoto', () => {
  it('verifies a receipt found by the photo’s hash', async () => {
    const photo = jpeg();
    const r = await receiptFor(photo);
    const f = respond(200, { receipts: [r] });
    const got = await checkPhoto(photo, undefined, { fetchTx: fetchTxFor(r), lookup: (h) => lookupReceipts(h, f) });
    expect(f).toHaveBeenCalledWith(`http://10.0.2.2:8080/v1/receipts?sha256=${sha256Hex(photo)}`);
    expect(got).toMatchObject({ found: 'lookup', results: [{ receipt: r, verdict: { ok: true, ledger: 77 } }] });
  });

  it('reports a looked-up receipt that does not verify', async () => {
    const photo = jpeg();
    const r = await receiptFor(photo);
    const got = await checkPhoto(photo, undefined, { fetchTx: async () => null, lookup: (h) => lookupReceipts(h, respond(200, { receipts: [r] })) });
    expect(got).toMatchObject({ found: 'lookup', results: [{ verdict: { ok: false, failedStep: 'anchor' } }] });
  });

  it('says none or pending when the service has nothing anchored', async () => {
    const deps = (status: number) => ({ fetchTx: async () => null, lookup: (h: string) => lookupReceipts(h, respond(status)) });
    await expect(checkPhoto(jpeg(), undefined, deps(404))).resolves.toEqual({ found: 'none' });
    await expect(checkPhoto(jpeg(), undefined, deps(202))).resolves.toEqual({ found: 'pending' });
  });

  it('verifies an embedded receipt against the stripped bytes, without a lookup', async () => {
    const original = jpeg();
    const r = await receiptFor(original);
    const lookup = jest.fn();
    const got = await checkPhoto(embedReceipt(original, JSON.stringify(r)).bytes, undefined, { fetchTx: fetchTxFor(r), lookup });
    expect(lookup).not.toHaveBeenCalled();
    expect(got).toMatchObject({ found: 'embedded', results: [{ verdict: { ok: true } }] });
  });

  it('reports a broken c2pa.hash.data hard binding as an error, not no proof found', async () => {
    const original = jpeg();
    const r = await receiptFor(original);
    const tampered = embedReceipt(original, JSON.stringify(r)).bytes;
    tampered[tampered.length - 5] ^= 0xff;
    const lookup = jest.fn();
    await expect(checkPhoto(tampered, undefined, { fetchTx: fetchTxFor(r), lookup })).rejects.toThrow(C2paFormatError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('uses a receipt file when given one', async () => {
    const photo = jpeg();
    const r = await receiptFor(photo);
    const lookup = jest.fn();
    const got = await checkPhoto(photo, JSON.stringify(r), { fetchTx: fetchTxFor(r), lookup });
    expect(lookup).not.toHaveBeenCalled();
    expect(got).toMatchObject({ found: 'file', results: [{ verdict: { ok: true } }] });
  });

  it('looks up the stripped bytes when C2PA from elsewhere changed the hash', async () => {
    const original = jpeg();
    const r = await receiptFor(original);
    const seen: string[] = [];
    const lookup = async (h: string) => {
      seen.push(h);
      return h === sha256Hex(original) ? await lookupReceipts(h, respond(200, { receipts: [r] })) : { status: 'none' as const };
    };
    const bare = embed(original, app11(superbox(C2PA, 'c2pa', superbox(C2MA, 'm'))));
    const got = await checkPhoto(bare, undefined, { fetchTx: fetchTxFor(r), lookup });
    expect(seen).toEqual([sha256Hex(bare), sha256Hex(original)]);
    expect(got).toMatchObject({ found: 'lookup', results: [{ verdict: { ok: true } }] });
  });

  describe('a photo embedded by the Go reference', () => {
    const fixture = fixtureBytes;
    const receipt = parseReceipt(fixtureText('receipt.json'));
    const fetchTx: FetchTx = async (_, hash) =>
      hash !== receipt.anchor.tx
        ? null
        : {
            successful: true,
            source_account: receipt.anchor.account,
            memo_type: 'hash',
            memo: btoa(String.fromCharCode(...hexToBytes(receipt.root))),
            ledger: receipt.anchor.ledger,
            created_at: receipt.anchor.closed_at,
          };

    it('verifies its embedded receipt with no lookup', async () => {
      const lookup = jest.fn();
      const got = await checkPhoto(fixture('embedded.jpg'), undefined, { fetchTx, lookup });
      expect(lookup).not.toHaveBeenCalled();
      expect(got).toMatchObject({ found: 'embedded', results: [{ receipt, verdict: { ok: true, ledger: 5565275, keyLevel: 'software' } }] });
    });

    it('shows an embedded attestation as claimed, not checked', async () => {
      const got = await checkPhoto(fixture('embedded-attested.jpg'), undefined, { fetchTx, lookup: jest.fn() });
      if (got.found !== 'embedded') throw new Error(got.found);
      const [{ verdict }] = got.results;
      expect(verdict).toMatchObject({ ok: true, keyLevel: 'unchecked', claimedAttestation: 'android-key' });
      expect(verdictLines(verdict)).toContain(
        'Key level: tee or strongbox, as claimed by its android-key attestation. Not checked by this app.',
      );
    });

    it('verifies the same photo by lookup once the receipt is stripped and sent separately', async () => {
      const original = fixture('original.jpg');
      const f = respond(200, { receipts: [receipt] });
      const got = await checkPhoto(original, undefined, { fetchTx, lookup: (h) => lookupReceipts(h, f) });
      expect(f).toHaveBeenCalledWith(`http://10.0.2.2:8080/v1/receipts?sha256=${sha256Hex(original)}`);
      expect(got).toMatchObject({ found: 'lookup', results: [{ verdict: { ok: true } }] });
    });

    it('checks a receipt file against the embedded photo’s signed bytes', async () => {
      const got = await checkPhoto(fixture('embedded.jpg'), JSON.stringify(receipt), { fetchTx, lookup: jest.fn() });
      expect(got).toMatchObject({ found: 'file', results: [{ verdict: { ok: true } }] });
    });
  });
});
