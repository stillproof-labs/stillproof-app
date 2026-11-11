// Client for the anchoring service, SPEC.md §7.
import type { Attestation } from '../modules/stillproof-keys';
import { anchorUrl } from './anchorUrl';
import { parseReceipt, type Receipt } from './protocol/receipt';

const CLAIM_TIMEOUT_MS = 15000;

/** Permanent 4xx rejection from the anchoring service; caller should fail rather than requeue. */
export class ClaimRejectedError extends Error {
  name = 'ClaimRejectedError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function submitClaim(signed: string): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CLAIM_TIMEOUT_MS);
  try {
    const res = await fetch(`${await anchorUrl()}/v1/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: signed,
      signal: abort.signal,
    });
    if (res.status !== 202) {
      const msg = `service rejected the claim (${res.status}): ${(await res.text()).trim()}`;
      if (res.status >= 400 && res.status < 500) throw new ClaimRejectedError(res.status, msg);
      throw new Error(msg);
    }
    const { id } = (await res.json()) as { id?: unknown };
    if (typeof id !== 'string') throw new Error('service returned no id');
    return id;
  } finally {
    clearTimeout(timer);
  }
}

export type ReceiptResult =
  | { status: 'pending' }
  | { status: 'unknown' }
  | { status: 'anchored'; receipt: Receipt; json: string };

export async function fetchReceipt(id: string): Promise<ReceiptResult> {
  const res = await fetch(`${await anchorUrl()}/v1/receipts/${id}`);
  if (res.status === 202) return { status: 'pending' };
  if (res.status === 404) return { status: 'unknown' };
  if (res.status !== 200) throw new Error(`service returned ${res.status}`);
  // Keep the service's exact bytes: that file is what gets shared.
  const json = await res.text();
  return { status: 'anchored', receipt: parseReceipt(json), json };
}

export type LookupResult =
  | { status: 'none' }
  | { status: 'pending' }
  | { status: 'found'; receipts: { receipt: Receipt; json: string }[] };

/** Every anchored receipt for a file with this SHA-256, oldest first (SPEC.md §8.4). */
export async function lookupReceipts(sha256: string, fetchFn: typeof fetch = fetch): Promise<LookupResult> {
  const res = await fetchFn(`${await anchorUrl()}/v1/receipts?sha256=${sha256}`);
  if (res.status === 404) return { status: 'none' };
  if (res.status === 202) return { status: 'pending' };
  if (res.status !== 200) throw new Error(`service returned ${res.status}`);
  const body = (await res.json()) as { receipts?: unknown };
  if (!Array.isArray(body.receipts)) throw new Error('service returned no receipts list');
  if (body.receipts.length === 0) return { status: 'none' };
  return {
    status: 'found',
    receipts: body.receipts.map((r) => {
      const json = JSON.stringify(r);
      return { receipt: parseReceipt(json), json };
    }),
  };
}

export type KeyRegistration = { accepted: true } | { accepted: false; reason: string };

const REGISTER_TIMEOUT_MS = 15000;

/** Registers a key's attestation, SPEC.md §8.4. Throws if the service can't be reached. */
export async function registerKey(key: string, attestation: Attestation): Promise<KeyRegistration> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REGISTER_TIMEOUT_MS);
  try {
    const res = await fetch(`${await anchorUrl()}/v1/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, attestation }),
      signal: abort.signal,
    });
    if (res.status === 204) return { accepted: true };
    if (res.status === 400) return { accepted: false, reason: (await res.text()).trim() || 'attestation rejected' };
    throw new Error(`service returned ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}
