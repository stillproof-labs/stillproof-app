// Local capture storage: each photo lives in the app's document directory next
// to its receipt, with a JSON index holding the signed claims and statuses.
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import { fetchReceipt, submitClaim, type ReceiptResult } from './api';
import { NETWORK } from './config';
import { deviceKey } from './keys';
import { buildClaim, claimId, signClaim, signedText } from './protocol/claim';
import { ReceiptFormatError } from './protocol/receipt';

export type CaptureStatus = 'pending' | 'anchored' | 'failed';

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
};

const dir = new Directory(Paths.document, 'captures');
const indexFile = new File(dir, 'captures.json');

const MEDIA_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic' };

let captures: Capture[] | undefined;
const listeners = new Set<() => void>();

function cleanupOrphans(list: Capture[]): void {
  const referenced = new Set<string>(['captures.json']);
  for (const c of list) {
    referenced.add(c.photo);
    referenced.add(c.receipt ?? `${c.id}.stillproof.json`);
  }
  for (const entry of dir.list()) {
    if (entry instanceof File && entry.name.startsWith('staged-') && !referenced.has(entry.name)) {
      try {
        if (entry.exists) entry.delete();
      } catch {
        // Best-effort orphan cleanup; keep existing captures usable.
      }
    }
  }
}

function all(): Capture[] {
  if (!captures) {
    if (!dir.exists) dir.create({ intermediates: true });
    captures = indexFile.exists ? (JSON.parse(indexFile.textSync()) as Capture[]) : [];
    cleanupOrphans(captures);
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

export function listCaptures(): readonly Capture[] {
  return all();
}

export function useCapture(id: string): Capture | undefined {
  return useCaptures().find((c) => c.id === id);
}

export const photoFile = (c: Capture) => new File(dir, c.photo);
export const receiptFile = (c: Capture) => new File(dir, c.receipt ?? `${c.id}.stillproof.json`);

/**
 * Deletes a capture from this device: its photo, receipt file and index entry
 * in one save. Never contacts the anchoring service; any anchored hash stays
 * on Stellar.
 */
export function deleteCapture(id: string): void {
  const list = all();
  const target = list.find((c) => c.id === id);
  if (!target) return;

  const rest = list.filter((c) => c.id !== id);
  const photo = photoFile(target);
  if (photo.exists && !rest.some((c) => c.photo === target.photo)) photo.delete();
  const receipt = receiptFile(target);
  if (receipt.exists && !rest.some((c) => (c.receipt ?? `${c.id}.stillproof.json`) === receipt.name)) receipt.delete();

  save(rest);
}

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
  return capture;
}

/** Sends the signed claim to the service. Safe to repeat: the service is idempotent. */
export async function submit(c: Capture): Promise<void> {
  try {
    const id = await submitClaim(c.signed);
    if (id !== c.id) throw new Error(`service returned id ${id}, expected ${c.id}`);
    update(c.id, { status: 'pending', error: undefined });
  } catch (e) {
    update(c.id, { status: 'failed', error: message(e) });
  }
}

/** Asks the service for the receipt of every pending capture. */
export async function pollPending(): Promise<void> {
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
      update(c.id, { status: 'failed', error: 'the service does not know this claim; submit it again' });
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
}
