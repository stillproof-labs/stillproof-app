import { hexToBytes } from '@noble/hashes/utils.js';

import type { Capture } from '../captures';
import { checkPhoto } from '../check';
import { exportToDirectory, pickAndExportCaptures, planExport, type ExportProgress } from '../export';
import { fixtureBytes, fixtureText } from '../protocol/__fixtures__/c2pa';
import { parseReceipt, type FetchTx } from '../protocol/receipt';

const mockFiles = new Map<string, Uint8Array>();
const mockDirs = new Set<string>(['file:///doc', 'file:///cache', 'content://tree/backup']);
const mockPickDirectoryAsync = jest.fn<Promise<{ uri: string }>, []>();

const mockEncodeUtf8 = (s: string) => new TextEncoder().encode(s);
const mockDecodeUtf8 = (b: Uint8Array) => new TextDecoder().decode(b);

function mockJoinUri(...parts: (string | { uri: string })[]): string {
  return parts
    .map((p, i) => {
      const s = typeof p === 'string' ? p : p.uri;
      return i === 0 ? s.replace(/\/+$/, '') : s.replace(/^\/+|\/+$/g, '');
    })
    .filter(Boolean)
    .join('/');
}

jest.mock('expo-secure-store', () => ({ getItemAsync: async () => null }));
jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));

jest.mock('expo-file-system', () => {
  class MockDirectory {
    static pickDirectoryAsync = (...args: []) => mockPickDirectoryAsync(...args);
    uri: string;
    constructor(...uris: (string | { uri: string })[]) {
      this.uri = mockJoinUri(...uris);
    }
    get exists() {
      return mockDirs.has(this.uri);
    }
    create() {
      mockDirs.add(this.uri);
    }
  }

  class MockFile {
    uri: string;
    constructor(...uris: (string | { uri: string })[]) {
      this.uri = mockJoinUri(...uris);
    }
    get name() {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    async bytes() {
      const data = mockFiles.get(this.uri);
      if (!data) throw new Error(`missing ${this.uri}`);
      return new Uint8Array(data);
    }
    async text() {
      return mockDecodeUtf8(await this.bytes());
    }
    textSync() {
      const data = mockFiles.get(this.uri);
      if (!data) throw new Error(`missing ${this.uri}`);
      return mockDecodeUtf8(data);
    }
    writeSync(content: string | Uint8Array) {
      mockFiles.set(this.uri, typeof content === 'string' ? mockEncodeUtf8(content) : new Uint8Array(content));
    }
    delete() {
      mockFiles.delete(this.uri);
    }
    async copy(destination: MockDirectory | MockFile, options?: { overwrite?: boolean }) {
      const data = mockFiles.get(this.uri);
      if (!data) throw new Error(`missing ${this.uri}`);
      const targetUri = destination instanceof MockDirectory ? mockJoinUri(destination.uri, this.name) : destination.uri;
      if (mockFiles.has(targetUri) && !options?.overwrite) {
        throw new Error('Destination already exists');
      }
      mockFiles.set(targetUri, new Uint8Array(data));
    }
  }

  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { document: 'file:///doc', cache: 'file:///cache' },
  };
});

function resetFs() {
  mockFiles.clear();
  mockDirs.clear();
  mockDirs.add('file:///doc');
  mockDirs.add('file:///cache');
  mockDirs.add('content://tree/backup');
  mockPickDirectoryAsync.mockReset();
}

const sampleCaptures = (): Capture[] => [
  {
    id: 'a'.repeat(64),
    signed: 'stillproof.v0\nanchored\n',
    type: 'image/jpeg',
    captured: '1762300800000',
    photo: `${'a'.repeat(64)}.jpg`,
    status: 'anchored',
    receipt: `${'a'.repeat(64)}.stillproof.json`,
  },
  {
    id: 'b'.repeat(64),
    signed: 'stillproof.v0\npending\n',
    type: 'image/png',
    captured: '1762300801000',
    photo: `${'b'.repeat(64)}.png`,
    status: 'pending',
  },
  {
    id: 'c'.repeat(64),
    signed: 'stillproof.v0\nfailed\n',
    type: 'image/heic',
    captured: '1762300802000',
    photo: `${'c'.repeat(64)}.heic`,
    status: 'failed',
    error: 'network timeout',
  },
];

describe('planExport', () => {
  it('plans photos, receipts for anchored captures, and captures.json for pending and failed captures', () => {
    const captures = sampleCaptures();
    const plan = planExport(captures);

    expect(plan.unanchoredCount).toBe(2);
    expect(plan.items).toHaveLength(5);

    expect(plan.items.slice(0, 4)).toEqual([
      {
        kind: 'copy',
        capture: captures[0],
        role: 'photo',
        sourceName: `${'a'.repeat(64)}.jpg`,
        destName: `${'a'.repeat(64)}.jpg`,
      },
      {
        kind: 'copy',
        capture: captures[0],
        role: 'receipt',
        sourceName: `${'a'.repeat(64)}.stillproof.json`,
        destName: `${'a'.repeat(64)}.stillproof.json`,
      },
      {
        kind: 'copy',
        capture: captures[1],
        role: 'photo',
        sourceName: `${'b'.repeat(64)}.png`,
        destName: `${'b'.repeat(64)}.png`,
      },
      {
        kind: 'copy',
        capture: captures[2],
        role: 'photo',
        sourceName: `${'c'.repeat(64)}.heic`,
        destName: `${'c'.repeat(64)}.heic`,
      },
    ]);

    const manifest = plan.items[4];
    expect(manifest.kind).toBe('json');
    if (manifest.kind !== 'json') throw new Error('expected json item');
    expect(manifest.destName).toBe('captures.json');
    expect(JSON.parse(manifest.content)).toEqual([captures[1], captures[2]]);
  });

  it('normalizes an anchored receipt destination name to <id>.stillproof.json', () => {
    const id = 'd'.repeat(64);
    const plan = planExport([
      {
        id,
        signed: 'stillproof.v0\n',
        type: 'image/jpeg',
        captured: '1762300800000',
        photo: `${id}.jpeg`,
        status: 'anchored',
        receipt: 'legacy-name.json',
      },
    ]);
    expect(plan.unanchoredCount).toBe(0);
    expect(plan.items.map((x) => ({ source: 'sourceName' in x ? x.sourceName : x.destName, dest: x.destName }))).toEqual([
      { source: `${id}.jpeg`, dest: `${id}.jpeg` },
      { source: 'legacy-name.json', dest: `${id}.stillproof.json` },
    ]);
  });

  it('omits captures.json when all captures are anchored or none exist', () => {
    expect(planExport([])).toEqual({ items: [], unanchoredCount: 0 });
    const anchoredOnly = sampleCaptures().slice(0, 1);
    const plan = planExport(anchoredOnly);
    expect(plan.unanchoredCount).toBe(0);
    expect(plan.items.every((item) => item.kind === 'copy')).toBe(true);
  });
});

describe('export execution', () => {
  beforeEach(resetFs);

  it('exports anchored photo + receipt unchanged so checkPhoto verifies them, plus captures.json', async () => {
    const original = fixtureBytes('original.jpg');
    const receiptJson = fixtureText('receipt.json');
    const receipt = parseReceipt(receiptJson);
    const anchoredId = 'a'.repeat(64);
    const captures: Capture[] = [
      {
        id: anchoredId,
        signed: receipt.claim,
        type: 'image/jpeg',
        captured: '1762300800000',
        photo: `${anchoredId}.jpg`,
        status: 'anchored',
        receipt: `${anchoredId}.stillproof.json`,
      },
      sampleCaptures()[1],
      sampleCaptures()[2],
    ];

    mockFiles.set(`file:///doc/captures/${anchoredId}.jpg`, original);
    mockFiles.set(`file:///doc/captures/${anchoredId}.stillproof.json`, mockEncodeUtf8(receiptJson));
    mockFiles.set(`file:///doc/captures/${captures[1].photo}`, mockEncodeUtf8('pending-png'));
    mockFiles.set(`file:///doc/captures/${captures[2].photo}`, mockEncodeUtf8('failed-heic'));

    const destUri = 'content://tree/backup';
    const { Directory } = jest.requireMock('expo-file-system') as { Directory: new (uri: string) => unknown };
    mockPickDirectoryAsync.mockResolvedValueOnce(new Directory(destUri) as { uri: string });

    const progress: ExportProgress[] = [];
    const summary = await pickAndExportCaptures({ captures, onProgress: (p) => progress.push(p) });

    expect(summary).toEqual({ total: 5, copied: 5, skipped: 0, failed: 0, errors: [] });
    expect(progress[0]).toEqual({ done: 0, total: 5, copied: 0, skipped: 0, failed: 0 });
    expect(progress[progress.length - 1]).toEqual({
      done: 5,
      total: 5,
      copied: 5,
      skipped: 0,
      failed: 0,
      current: 'captures.json',
    });

    const exportedPhoto = mockFiles.get(`${destUri}/${anchoredId}.jpg`)!;
    const exportedReceipt = mockDecodeUtf8(mockFiles.get(`${destUri}/${anchoredId}.stillproof.json`)!);
    expect(exportedPhoto).toEqual(original);
    expect(exportedReceipt).toBe(receiptJson);
    expect(JSON.parse(mockDecodeUtf8(mockFiles.get(`${destUri}/captures.json`)!))).toEqual([captures[1], captures[2]]);

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
    const checked = await checkPhoto(exportedPhoto, exportedReceipt, { fetchTx, lookup: jest.fn() });
    expect(checked).toMatchObject({ found: 'file', results: [{ verdict: { ok: true, ledger: receipt.anchor.ledger } }] });
  });

  it('skips existing files cleanly and overwrites captures.json on re-export', async () => {
    const captures = sampleCaptures();
    mockFiles.set(`file:///doc/captures/${captures[0].photo}`, mockEncodeUtf8('jpg'));
    mockFiles.set(`file:///doc/captures/${captures[0].receipt}`, mockEncodeUtf8('{"v":1}'));
    mockFiles.set(`file:///doc/captures/${captures[1].photo}`, mockEncodeUtf8('png'));
    mockFiles.set(`file:///doc/captures/${captures[2].photo}`, mockEncodeUtf8('heic'));

    const destUri = 'content://tree/backup';
    mockFiles.set(`${destUri}/${captures[0].photo}`, mockEncodeUtf8('jpg'));
    mockFiles.set(`${destUri}/${captures[0].receipt}`, mockEncodeUtf8('{"v":1}'));
    mockFiles.set(`${destUri}/captures.json`, mockEncodeUtf8('[]'));

    const { Directory } = jest.requireMock('expo-file-system') as { Directory: new (uri: string) => unknown };
    const summary = await exportToDirectory(new Directory(destUri) as never, { captures });

    expect(summary).toEqual({ total: 5, copied: 3, skipped: 2, failed: 0, errors: [] });
    expect(JSON.parse(mockDecodeUtf8(mockFiles.get(`${destUri}/captures.json`)!))).toHaveLength(2);
  });

  it('counts missing files as failed without stopping the rest of the export', async () => {
    const captures = sampleCaptures().slice(0, 2);
    mockFiles.set(`file:///doc/captures/${captures[0].photo}`, mockEncodeUtf8('jpg'));
    // Deliberately omit captures[0].receipt from disk.
    mockFiles.set(`file:///doc/captures/${captures[1].photo}`, mockEncodeUtf8('png'));

    const destUri = 'content://tree/backup';
    const { Directory } = jest.requireMock('expo-file-system') as { Directory: new (uri: string) => unknown };
    const summary = await exportToDirectory(new Directory(destUri) as never, { captures });

    expect(summary).toMatchObject({ total: 4, copied: 3, skipped: 0, failed: 1 });
    expect(summary.errors[0]).toContain(`${captures[0].id}.stillproof.json`);
  });

  it('returns undefined when the user cancels the folder picker', async () => {
    mockPickDirectoryAsync.mockRejectedValueOnce(new Error('The file picker was cancelled by the user'));
    await expect(pickAndExportCaptures({ captures: sampleCaptures() })).resolves.toBeUndefined();
  });
});
