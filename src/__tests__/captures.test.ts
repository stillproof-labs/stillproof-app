import { bytesToHex } from '@noble/hashes/utils.js';
import type { NetInfoChangeHandler, NetInfoState } from '@react-native-community/netinfo';
import { AppState, type AppStateStatus } from 'react-native';

import {
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  _resetForTests,
  createCapture,
  nextRetryDelay,
  pollPending,
  retryQueued,
  startCaptureSync,
  type Capture,
} from '../captures';
import { leafHash, parseSignedClaim } from '../protocol/claim';
import type { Receipt } from '../protocol/receipt';

const mockFiles = new Map<string, Uint8Array>();
const mockDirs = new Set<string>(['file:///doc', 'file:///doc/captures']);
const mockStore = new Map<string, string>();
const mockNetListeners = new Set<NetInfoChangeHandler>();

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

jest.mock('../../modules/stillproof-keys', () => ({ __esModule: true, default: null }));

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void mockStore.set(k, v),
  deleteItemAsync: async (k: string) => void mockStore.delete(k),
}));

jest.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
}));

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn((listener: NetInfoChangeHandler) => {
      mockNetListeners.add(listener);
      return () => {
        mockNetListeners.delete(listener);
      };
    }),
  },
}));

jest.mock('expo-file-system', () => {
  class MockDirectory {
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
    get extension() {
      const i = this.name.lastIndexOf('.');
      return i === -1 ? '' : this.name.slice(i);
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    async bytes() {
      const data = mockFiles.get(this.uri);
      if (!data) throw new Error(`missing ${this.uri}`);
      return new Uint8Array(data);
    }
    textSync() {
      const data = mockFiles.get(this.uri);
      if (!data) throw new Error(`missing ${this.uri}`);
      return mockDecodeUtf8(data);
    }
    writeSync(content: string | Uint8Array) {
      mockFiles.set(this.uri, typeof content === 'string' ? mockEncodeUtf8(content) : new Uint8Array(content));
    }
    copySync(dest: MockFile) {
      const data = mockFiles.get(this.uri);
      if (!data) throw new Error(`missing ${this.uri}`);
      mockFiles.set(dest.uri, new Uint8Array(data));
    }
    rename(newName: string) {
      const data = mockFiles.get(this.uri);
      if (!data) throw new Error(`missing ${this.uri}`);
      const nextUri = mockJoinUri(this.uri.slice(0, this.uri.lastIndexOf('/')), newName);
      mockFiles.delete(this.uri);
      mockFiles.set(nextUri, data);
      this.uri = nextUri;
    }
    delete() {
      mockFiles.delete(this.uri);
    }
  }

  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { document: 'file:///doc', cache: 'file:///cache' },
  };
});

const fetchCalls: { url: string; method: string; body: string | undefined }[] = [];
const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit | undefined]>();

function emitNetInfo(isConnected: boolean, isInternetReachable: boolean | null = isConnected) {
  const state = { isConnected, isInternetReachable } as NetInfoState;
  mockNetListeners.forEach((l) => l(state));
}

function anchoredReceiptFor(signed: string): Receipt {
  return {
    v: 1,
    claim: signed,
    index: 0,
    size: 1,
    proof: [],
    root: bytesToHex(leafHash(signed)),
    anchor: {
      network: 'testnet',
      account: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
      tx: 'b'.repeat(64),
      ledger: 99,
      closed_at: '2026-11-11T00:00:00Z',
    },
  };
}

function readIndex(): Capture[] {
  const raw = mockFiles.get('file:///doc/captures/captures.json');
  return raw ? (JSON.parse(mockDecodeUtf8(raw)) as Capture[]) : [];
}

beforeEach(() => {
  jest.useRealTimers();
  mockFiles.clear();
  mockDirs.clear();
  mockDirs.add('file:///doc');
  mockDirs.add('file:///doc/captures');
  mockStore.clear();
  mockNetListeners.clear();
  fetchCalls.length = 0;
  fetchMock.mockReset();
  _resetForTests();

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return fetchMock(input, init);
  }) as typeof fetch;
});

describe('offline capture queue', () => {
  it('queues a capture when submission fails with a network error and submits exact signed bytes when connectivity returns', async () => {
    const camUri = 'file:///cam/shutter-1.jpg';
    const shutterMs = 1762300800123;
    mockFiles.set(camUri, mockEncodeUtf8('jpeg-bytes'));

    // Offline at capture time.
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    const capture = await createCapture(camUri, shutterMs);

    expect(capture.status).toBe('queued');
    expect(capture.captured).toBe(String(shutterMs));
    expect(parseSignedClaim(capture.signed).captured).toBe(BigInt(shutterMs));

    let currentHandler: ((state: AppStateStatus) => void) | undefined;
    const appSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      currentHandler = handler;
      return { remove: jest.fn() };
    });

    const stop = startCaptureSync();
    try {
      // Simulate offline then back online.
      emitNetInfo(false, false);

      const receipt = anchoredReceiptFor(capture.signed);
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: capture.id }), { status: 202 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));

      emitNetInfo(true, true);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      const updated = readIndex().find((c) => c.id === capture.id)!;
      expect(updated.status).toBe('anchored');
      expect(updated.captured).toBe(String(shutterMs));

      const claimsPosts = fetchCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/claims'));
      expect(claimsPosts).toHaveLength(2);
      expect(claimsPosts[0].body).toBe(capture.signed);
      expect(claimsPosts[1].body).toBe(capture.signed);

      const savedReceipt = JSON.parse(mockDecodeUtf8(mockFiles.get(`file:///doc/captures/${capture.id}.stillproof.json`)!)) as Receipt;
      expect(savedReceipt.claim).toBe(capture.signed);
      expect(parseSignedClaim(savedReceipt.claim).captured).toBe(BigInt(shutterMs));
      expect(currentHandler).toBeDefined();
    } finally {
      stop();
      appSpy.mockRestore();
    }
  });

  it('queues on 5xx and timeouts rather than failing', async () => {
    const cam503 = 'file:///cam/503.jpg';
    mockFiles.set(cam503, mockEncodeUtf8('jpeg-503'));
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }));
    const c503 = await createCapture(cam503, 1762300801000);
    expect(c503.status).toBe('queued');

    jest.useFakeTimers();
    const camTimeout = 'file:///cam/timeout.jpg';
    mockFiles.set(camTimeout, mockEncodeUtf8('jpeg-timeout'));
    fetchMock.mockImplementationOnce((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    const pendingCapture = createCapture(camTimeout, 1762300802000);
    await jest.advanceTimersByTimeAsync(15000);
    const cTimeout = await pendingCapture;
    expect(cTimeout.status).toBe('queued');
  });

  it('marks 400 rejections as failed and does not retry them automatically', async () => {
    const camUri = 'file:///cam/bad.jpg';
    mockFiles.set(camUri, mockEncodeUtf8('bad-claim'));
    fetchMock.mockResolvedValueOnce(new Response('malformed signature', { status: 400 }));

    const capture = await createCapture(camUri, 1762300803000);
    expect(capture.status).toBe('failed');
    expect(capture.error).toContain('400');

    const submitted = await retryQueued();
    expect(submitted).toBe(false);
    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('resubmits the exact signed claim once on unknown (404), then fails if unknown repeats', async () => {
    const camUri = 'file:///cam/unknown.jpg';
    mockFiles.set(camUri, mockEncodeUtf8('jpeg-unknown'));
    fetchMock.mockResolvedValueOnce(new Response('server restarted before saving', { status: 503 }));

    const queued = await createCapture(camUri, 1762300804000);
    expect(queued.status).toBe('queued');

    // Initial accepted submission -> pending.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: queued.id }), { status: 202 }));
    await retryQueued();
    expect(readIndex()[0].status).toBe('pending');

    // First 404 unknown triggers one resubmission with identical signed bytes -> 202 pending.
    fetchMock
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: queued.id }), { status: 202 }));
    await pollPending();

    const postBodies = fetchCalls.filter((c) => c.method === 'POST').map((c) => c.body);
    expect(postBodies).toHaveLength(3);
    expect(postBodies[2]).toBe(queued.signed);
    expect(readIndex()[0]).toMatchObject({ status: 'pending', retriedUnknown: true });

    // Second 404 unknown marks failed without calling POST /v1/claims again.
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    await pollPending();

    expect(fetchCalls.filter((c) => c.method === 'POST')).toHaveLength(3);
    expect(readIndex()[0].status).toBe('failed');
  });

  it('flushes queued captures when the app returns to foreground and computes exponential backoff', async () => {
    expect(nextRetryDelay(1)).toBe(RETRY_BASE_MS);
    expect(nextRetryDelay(2)).toBe(RETRY_BASE_MS * 2);
    expect(nextRetryDelay(10)).toBe(RETRY_MAX_MS);

    let appListener: ((s: AppStateStatus) => void) | undefined;
    const appSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      appListener = handler;
      return { remove: jest.fn() };
    });

    const camUri = 'file:///cam/fg.jpg';
    mockFiles.set(camUri, mockEncodeUtf8('jpeg-fg'));
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    const queued = await createCapture(camUri, 1762300805000);
    expect(queued.status).toBe('queued');

    const stop = startCaptureSync();
    try {
      const receipt = anchoredReceiptFor(queued.signed);
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: queued.id }), { status: 202 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));

      appListener!('active');
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(readIndex().find((c) => c.id === queued.id)?.status).toBe('anchored');
    } finally {
      stop();
      appSpy.mockRestore();
    }
  });

  it('retries queued captures automatically via exponential backoff timer', async () => {
    jest.useFakeTimers();
    const camUri = 'file:///cam/backoff.jpg';
    mockFiles.set(camUri, mockEncodeUtf8('jpeg-backoff'));
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));

    const queued = await createCapture(camUri, 1762300806000);
    expect(queued.status).toBe('queued');

    const appSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() }));
    const stop = startCaptureSync();
    try {
      const receipt = anchoredReceiptFor(queued.signed);
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify({ id: queued.id }), { status: 202 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(receipt), { status: 200 }));

      await jest.advanceTimersByTimeAsync(RETRY_BASE_MS);
      expect(readIndex().find((c) => c.id === queued.id)?.status).toBe('anchored');
    } finally {
      stop();
      appSpy.mockRestore();
    }
  });
});
