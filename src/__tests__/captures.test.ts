import type * as Captures from '../captures';

const dirs = new Set<string>();
const files = new Map<string, Uint8Array>();
const indexWrites: string[] = [];

function normalize(...parts: (string | { uri: string })[]): string {
  return parts
    .map((p) => (typeof p === 'string' ? p : p.uri))
    .map((s, i) => (i === 0 ? s.replace(/\/+$/, '') : s.replace(/^\/+|\/+$/g, '')))
    .filter((s) => s.length > 0)
    .join('/');
}

class MockDirectory {
  readonly uri: string;
  constructor(...parts: (string | MockFile | MockDirectory)[]) {
    this.uri = normalize(...parts);
  }
  get exists(): boolean {
    return dirs.has(this.uri);
  }
  create(): void {
    dirs.add(this.uri);
  }
  list(): (MockDirectory | MockFile)[] {
    const prefix = `${this.uri}/`;
    const entries: (MockDirectory | MockFile)[] = [];
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest.includes('/')) entries.push(new MockFile(path));
    }
    return entries;
  }
}

class MockFile {
  uri: string;
  constructor(...parts: (string | MockFile | MockDirectory)[]) {
    this.uri = normalize(...parts);
  }
  get name(): string {
    return this.uri.slice(this.uri.lastIndexOf('/') + 1);
  }
  get extension(): string {
    const dot = this.name.lastIndexOf('.');
    return dot >= 0 ? this.name.slice(dot) : '';
  }
  get exists(): boolean {
    return files.has(this.uri);
  }
  textSync(): string {
    const data = files.get(this.uri);
    if (!data) throw new Error(`missing file: ${this.uri}`);
    return new TextDecoder().decode(data);
  }
  writeSync(content: string | Uint8Array): void {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    files.set(this.uri, bytes);
    if (this.name === 'captures.json') indexWrites.push(typeof content === 'string' ? content : this.textSync());
  }
  async bytes(): Promise<Uint8Array> {
    const data = files.get(this.uri);
    if (!data) throw new Error(`missing file: ${this.uri}`);
    return new Uint8Array(data);
  }
  copySync(dest: MockFile): void {
    const data = files.get(this.uri);
    if (!data) throw new Error(`missing source: ${this.uri}`);
    files.set(dest.uri, new Uint8Array(data));
  }
  rename(newName: string): void {
    const data = files.get(this.uri);
    if (!data) throw new Error(`missing file: ${this.uri}`);
    const parent = this.uri.slice(0, this.uri.lastIndexOf('/'));
    const next = normalize(parent, newName);
    files.delete(this.uri);
    files.set(next, data);
    this.uri = next;
  }
  delete(): void {
    if (!files.delete(this.uri)) throw new Error(`cannot delete missing file: ${this.uri}`);
  }
}

jest.mock('expo-file-system', () => ({
  Directory: MockDirectory,
  File: MockFile,
  Paths: { document: 'file:///doc' },
}));

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

jest.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
}));

const DOC_CAPTURES = 'file:///doc/captures';
const INDEX_URI = `${DOC_CAPTURES}/captures.json`;

function loadCaptures(deviceKeyMock?: jest.Mock): typeof Captures {
  jest.resetModules();
  if (deviceKeyMock) {
    jest.doMock('../keys', () => ({ deviceKey: deviceKeyMock }));
  }
  return jest.requireActual<typeof Captures>('../captures');
}

function seedIndex(entries: Captures.Capture[]): void {
  dirs.add(DOC_CAPTURES);
  files.set(INDEX_URI, new TextEncoder().encode(JSON.stringify(entries)));
}

const makeCapture = (id: string, overrides: Partial<Captures.Capture> = {}): Captures.Capture => ({
  id,
  signed: `stillproof/claim/v0\nsha256 ${id}\ntype image/jpeg\ncaptured 1700000000000\nkey ${'0'.repeat(130)}\nsig ${'1'.repeat(128)}\n`,
  type: 'image/jpeg',
  captured: '1700000000000',
  photo: `${id}.jpg`,
  status: 'anchored',
  receipt: `${id}.stillproof.json`,
  ...overrides,
});

const fetchSpy = jest.fn();

beforeEach(() => {
  dirs.clear();
  files.clear();
  indexWrites.length = 0;
  fetchSpy.mockReset();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

describe('deleteCapture', () => {
  it('deletes the photo, receipt file, and index entry in a single save without contacting the service', () => {
    const a = makeCapture('a'.repeat(64));
    const b = makeCapture('b'.repeat(64));
    seedIndex([a, b]);
    files.set(`${DOC_CAPTURES}/${a.photo}`, new Uint8Array([1, 2, 3]));
    files.set(`${DOC_CAPTURES}/${a.receipt}`, new TextEncoder().encode('{"v":1}'));
    files.set(`${DOC_CAPTURES}/${b.photo}`, new Uint8Array([4, 5, 6]));
    files.set(`${DOC_CAPTURES}/${b.receipt}`, new TextEncoder().encode('{"v":1}'));

    const mod = loadCaptures();
    indexWrites.length = 0;

    mod.deleteCapture(a.id);

    expect(indexWrites).toHaveLength(1);
    expect(JSON.parse(indexWrites[0])).toEqual([b]);
    expect(mod.listCaptures()).toEqual([b]);
    expect(files.has(`${DOC_CAPTURES}/${a.photo}`)).toBe(false);
    expect(files.has(`${DOC_CAPTURES}/${a.receipt}`)).toBe(false);
    expect(files.has(`${DOC_CAPTURES}/${b.photo}`)).toBe(true);
    expect(files.has(`${DOC_CAPTURES}/${b.receipt}`)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Persists across a fresh module load.
    expect(loadCaptures().listCaptures()).toEqual([b]);
  });

  it('handles pending captures without a receipt file and unknown ids cleanly', () => {
    const pending = makeCapture('c'.repeat(64), { status: 'pending', receipt: undefined });
    seedIndex([pending]);
    files.set(`${DOC_CAPTURES}/${pending.photo}`, new Uint8Array([9]));

    const mod = loadCaptures();
    mod.deleteCapture('missing-id');
    expect(indexWrites).toHaveLength(0);
    expect(mod.listCaptures()).toEqual([pending]);

    mod.deleteCapture(pending.id);
    expect(indexWrites).toHaveLength(1);
    expect(mod.listCaptures()).toEqual([]);
    expect(files.has(`${DOC_CAPTURES}/${pending.photo}`)).toBe(false);
  });
});

describe('orphan staged-* cleanup on load', () => {
  it('removes unreferenced staged-* files while keeping referenced photos and receipts', () => {
    const keep = makeCapture('d'.repeat(64));
    const stagedReferenced = makeCapture('e'.repeat(64), { photo: 'staged-referenced.jpg', receipt: undefined, status: 'pending' });
    seedIndex([keep, stagedReferenced]);
    files.set(`${DOC_CAPTURES}/${keep.photo}`, new Uint8Array([1]));
    files.set(`${DOC_CAPTURES}/${keep.receipt}`, new TextEncoder().encode('{}'));
    files.set(`${DOC_CAPTURES}/${stagedReferenced.photo}`, new Uint8Array([2]));
    files.set(`${DOC_CAPTURES}/staged-1700000000001.jpg`, new Uint8Array([3]));
    files.set(`${DOC_CAPTURES}/staged-1700000000002.png`, new Uint8Array([4]));
    files.set(`${DOC_CAPTURES}/unrelated.jpg`, new Uint8Array([5]));

    const mod = loadCaptures();
    expect(mod.listCaptures()).toEqual([keep, stagedReferenced]);
    expect(files.has(`${DOC_CAPTURES}/staged-1700000000001.jpg`)).toBe(false);
    expect(files.has(`${DOC_CAPTURES}/staged-1700000000002.png`)).toBe(false);
    expect(files.has(`${DOC_CAPTURES}/${keep.photo}`)).toBe(true);
    expect(files.has(`${DOC_CAPTURES}/${keep.receipt}`)).toBe(true);
    expect(files.has(`${DOC_CAPTURES}/${stagedReferenced.photo}`)).toBe(true);
    expect(files.has(`${DOC_CAPTURES}/unrelated.jpg`)).toBe(true);
    expect(files.has(INDEX_URI)).toBe(true);
  });

  it('cleans up staged-* files left behind when createCapture fails during signing', async () => {
    files.set('file:///tmp/cam.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const failingKey = jest.fn(async () => ({
      publicKey: () => `04${'1'.repeat(128)}`,
      sign: async () => {
        throw new Error('keystore error');
      },
    }));

    const first = loadCaptures(failingKey);
    await expect(first.createCapture('file:///tmp/cam.jpg', 1700000123456)).rejects.toThrow();
    expect(files.has(`${DOC_CAPTURES}/staged-1700000123456.jpg`)).toBe(true);

    // On next load, the abandoned staged file is cleaned up.
    const reloaded = loadCaptures();
    expect(reloaded.listCaptures()).toEqual([]);
    expect(files.has(`${DOC_CAPTURES}/staged-1700000123456.jpg`)).toBe(false);
  });
});
