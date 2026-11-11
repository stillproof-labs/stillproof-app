// Local capture storage: each photo lives in the app's document directory next
// to its receipt, with a JSON index holding the signed claims and statuses.
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { ClaimRejectedError, fetchReceipt, submitClaim, type ReceiptResult } from './api';
import { NETWORK, POLL_MS } from './config';
import { deviceKey } from './keys';
import { buildClaim, claimId, signClaim, signedText } from './protocol/claim';
import { ReceiptFormatError } from './protocol/receipt';

export type CaptureStatus = 'queued' | 'pending' | 'anchored' | 'failed';

export type Capture = {
  id: string;
  signed: string;
  type: string;
  /** Device-claimed capture time, unix ms as a decimal string. */
  captured: string;
  photo: string;
  status: CaptureStatus;
  error?: string;
  receipt?: string;
  /** Set once "unknown" (404) triggers an automatic resubmission of the stored claim. */
  retriedUnknown?: boolean;
};

export const RETRY_BASE_MS = 2000;
export const RETRY_MAX_MS = 60000;

export function nextRetryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

const dir = new Directory(Paths.document, 'captures');
const indexFile = new File(dir, 'captures.json');

const MEDIA_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic' };

let captures: Capture[] | undefined;
const listeners = new Set<() => void>();

function all(): Capture[] {
  if (!captures) {
    if (!dir.exists) dir.create({ intermediates: true });
    captures = indexFile.exists ? (JSON.parse(indexFile.textSync()) as Capture[]) : [];
  }
  return captures;
}

function save(next: Capture[]): void {
  indexFile.writeSync(JSON.stringify(next));
  captures = next;
  listeners.forEach((l) => l());
}

function update(id: string, patch: Partial<Capture>): void {
  save(all().map((c) => (c.id === id ? { ...c, ...patch } : c)));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCaptures(): Capture[] {
  return useSyncExternalStore(subscribe, all);
}

export function useCapture(id: string): Capture | undefined {
  return useCaptures().find((c) => c.id === id);
}

export const photoFile = (c: Capture) => new File(dir, c.photo);
export const receiptFile = (c: Capture) => new File(dir, c.receipt ?? `${c.id}.stillproof.json`);

/**
 * Stores a photo the camera just wrote, signs its claim and submits it.
 * The capture is kept even if submission fails, so it can be retried.
 */
export async function createCapture(pictureUri: string, capturedAt: number): Promise<Capture> {
  const source = new File(pictureUri);
  const ext = source.extension.replace('.', '').toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) throw new Error(`unsupported camera output: ${source.name}`);

  all();
  const staged = new File(dir, `staged-${capturedAt}.${ext}`);
  source.copySync(staged);
  // Hash the bytes as stored, so the claim covers exactly the file we keep and share.
  const bytes = await staged.bytes();
  const key = await deviceKey();
  const signed = await signClaim(buildClaim(bytes, type, BigInt(capturedAt), key.publicKey()), (m) => key.sign(m));
  const id = claimId(signed);
  const photo = `${id}.${ext}`;
  staged.rename(photo);
  source.delete();

  const capture: Capture = { id, signed: signedText(signed), type, captured: String(capturedAt), photo, status: 'pending' };
  save([capture, ...all().filter((c) => c.id !== id)]);
  await submit(capture);
  return all().find((c) => c.id === id) ?? capture;
}

/** Sends the stored signed claim to the service, byte for byte. */
export async function submit(c: Capture, options?: { fromUnknown?: boolean }): Promise<void> {
  const retriedUnknown = options?.fromUnknown ? true : undefined;
  try {
    const id = await submitClaim(c.signed);
    if (id !== c.id) throw new ClaimRejectedError(400, `service returned id ${id}, expected ${c.id}`);
    update(c.id, { status: 'pending', error: undefined, retriedUnknown });
  } catch (e) {
    const status: CaptureStatus = e instanceof ClaimRejectedError ? 'failed' : 'queued';
    update(c.id, { status, error: message(e), retriedUnknown });
  }
}

let polling: Promise<void> | undefined;

/** Asks the service for the receipt of every pending capture. */
export function pollPending(): Promise<void> {
  if (polling) return polling;
  polling = (async () => {
    for (const c of all().filter((x) => x.status === 'pending')) {
      let r: ReceiptResult;
      try {
        r = await fetchReceipt(c.id);
      } catch (e) {
        // Network and server errors are transient: stay pending. A malformed receipt is not.
        if (e instanceof ReceiptFormatError) update(c.id, { status: 'failed', error: message(e) });
        continue;
      }
      if (r.status === 'unknown') {
        if (!c.retriedUnknown) {
          await submit(c, { fromUnknown: true });
        } else {
          update(c.id, { status: 'failed', error: 'the service does not know this claim; submit it again' });
        }
      } else if (r.status === 'anchored') {
        if (r.receipt.claim !== c.signed) {
          update(c.id, { status: 'failed', error: 'the service returned a receipt for a different claim' });
        } else if (r.receipt.anchor.network !== NETWORK) {
          update(c.id, { status: 'failed', error: `receipt is anchored on ${r.receipt.anchor.network}, not ${NETWORK}` });
        } else {
          const file = receiptFile(c);
          file.writeSync(r.json);
          update(c.id, { status: 'anchored', receipt: file.name, error: undefined });
        }
      }
    }
  })().finally(() => {
    polling = undefined;
  });
  return polling;
}

let retrying: Promise<boolean> | undefined;

/** Submits every queued capture without changing or re-signing the stored claim. */
export function retryQueued(): Promise<boolean> {
  if (retrying) return retrying;
  retrying = (async () => {
    let submittedAny = false;
    for (const c of all().filter((x) => x.status === 'queued')) {
      await submit(c, c.retriedUnknown ? { fromUnknown: true } : undefined);
      if (all().find((x) => x.id === c.id)?.status === 'pending') submittedAny = true;
    }
    return submittedAny;
  })().finally(() => {
    retrying = undefined;
  });
  return retrying;
}

const isOnline = (state: NetInfoState): boolean => Boolean(state.isConnected) && state.isInternetReachable !== false;

/**
 * Coordinates automatic retries with exponential backoff, foreground recovery,
 * connectivity recovery, and receipt polling while the app is open.
 */
export function startCaptureSync(): () => void {
  let stopped = false;
  let flushing = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let prevOnline: boolean | undefined;

  const hasQueued = () => all().some((x) => x.status === 'queued');
  const hasPending = () => all().some((x) => x.status === 'pending');

  const clearRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const clearPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const syncPollTimer = () => {
    if (stopped || !hasPending()) {
      clearPoll();
      return;
    }
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        if (!stopped) void pollPending();
      }, POLL_MS);
    }
  };

  const scheduleRetry = () => {
    if (stopped || flushing || retryTimer || !hasQueued()) return;
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void flush(false);
    }, nextRetryDelay(attempt));
  };

  const flush = async (resetBackoff: boolean) => {
    if (stopped) return;
    if (resetBackoff) {
      attempt = 0;
      clearRetry();
    }
    flushing = true;
    try {
      if (hasQueued()) await retryQueued();
      if (!stopped && hasPending()) await pollPending();
    } finally {
      flushing = false;
    }
    if (stopped) return;
    syncPollTimer();
    if (hasQueued()) {
      scheduleRetry();
    } else {
      attempt = 0;
      clearRetry();
    }
  };

  const unsubscribeStore = subscribe(() => {
    syncPollTimer();
    if (hasQueued()) {
      scheduleRetry();
    } else {
      attempt = 0;
      clearRetry();
    }
  });

  const appSub = AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') void flush(true);
  });

  const netUnsub = NetInfo.addEventListener((state: NetInfoState) => {
    const online = isOnline(state);
    if (online && prevOnline !== true) void flush(true);
    prevOnline = online;
  });

  syncPollTimer();
  if (hasQueued()) scheduleRetry();

  return () => {
    stopped = true;
    clearRetry();
    clearPoll();
    unsubscribeStore();
    appSub.remove();
    netUnsub();
  };
}

export function useCaptureSync(): void {
  useEffect(() => startCaptureSync(), []);
}

/** For tests: forget the cached capture list and listeners. */
export function _resetForTests(): void {
  captures = undefined;
  listeners.clear();
  polling = undefined;
  retrying = undefined;
}
