// Bulk backup of captures and receipts to a user-chosen folder (SAF on Android, folder picker on iOS).
import { Directory, File, Paths } from 'expo-file-system';

import { listCaptures, photoFile, receiptFile, type Capture } from './captures';

export type ExportItem =
  | { kind: 'copy'; capture: Capture; role: 'photo' | 'receipt'; sourceName: string; destName: string }
  | { kind: 'json'; destName: 'captures.json'; captures: Capture[]; content: string };

export type ExportPlan = {
  items: ExportItem[];
  unanchoredCount: number;
};

export type ExportProgress = {
  done: number;
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  current?: string;
};

export type ExportSummary = {
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  errors: string[];
};

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function isCancelledError(e: unknown): boolean {
  const msg = errorMessage(e).toLowerCase();
  return msg.includes('cancelled') || msg.includes('canceled');
}

function isAlreadyExistsError(e: unknown): boolean {
  const msg = errorMessage(e).toLowerCase();
  return msg.includes('already exists') || msg.includes('destination exists') || msg.includes('file exists');
}

/**
 * Computes the pure list of file operations needed to back up captures:
 * - Every capture's photo keeps its filename and extension unchanged.
 * - Anchored captures include `<id>.stillproof.json` next to the photo.
 * - Pending and failed captures are written together in `captures.json` with their signed claims.
 */
export function planExport(captures: readonly Capture[]): ExportPlan {
  const items: ExportItem[] = [];
  const unanchored: Capture[] = [];
  const seenFiles = new Set<string>();

  for (const capture of captures) {
    if (!seenFiles.has(capture.photo)) {
      seenFiles.add(capture.photo);
      items.push({
        kind: 'copy',
        capture,
        role: 'photo',
        sourceName: capture.photo,
        destName: capture.photo,
      });
    }

    if (capture.status === 'anchored') {
      const destName = `${capture.id}.stillproof.json`;
      if (!seenFiles.has(destName)) {
        seenFiles.add(destName);
        items.push({
          kind: 'copy',
          capture,
          role: 'receipt',
          sourceName: capture.receipt ?? destName,
          destName,
        });
      }
    } else {
      unanchored.push({ ...capture });
    }
  }

  if (unanchored.length > 0) {
    items.push({
      kind: 'json',
      destName: 'captures.json',
      captures: unanchored,
      content: JSON.stringify(unanchored, null, 2),
    });
  }

  return { items, unanchoredCount: unanchored.length };
}

function stagingDir(): Directory {
  const dir = new Directory(Paths.cache, 'stillproof-export');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

async function copyItem(item: Extract<ExportItem, { kind: 'copy' }>, destination: Directory): Promise<'copied' | 'skipped'> {
  const src = item.role === 'photo' ? photoFile(item.capture) : receiptFile(item.capture);
  if (!src.exists) throw new Error(`missing source file ${item.sourceName}`);

  if (item.sourceName === item.destName) {
    try {
      await src.copy(destination);
      return 'copied';
    } catch (e) {
      if (isAlreadyExistsError(e)) return 'skipped';
      throw e;
    }
  }

  const staged = new File(stagingDir(), item.destName);
  try {
    if (staged.exists) staged.delete();
    await src.copy(staged);
    await staged.copy(destination);
    return 'copied';
  } catch (e) {
    if (isAlreadyExistsError(e)) return 'skipped';
    throw e;
  } finally {
    try {
      if (staged.exists) staged.delete();
    } catch {
      // Ignore temporary cleanup failures.
    }
  }
}

async function writeJsonItem(item: Extract<ExportItem, { kind: 'json' }>, destination: Directory): Promise<void> {
  const staged = new File(stagingDir(), item.destName);
  try {
    if (staged.exists) staged.delete();
    staged.writeSync(item.content);
    // Pending/failed index updates over time, so replace any prior backup manifest.
    await staged.copy(destination, { overwrite: true });
  } finally {
    try {
      if (staged.exists) staged.delete();
    } catch {
      // Ignore temporary cleanup failures.
    }
  }
}

/** Copies planned captures and receipts into an already-picked destination directory. */
export async function exportToDirectory(
  destination: Directory,
  options?: {
    captures?: readonly Capture[];
    onProgress?: (progress: ExportProgress) => void;
  },
): Promise<ExportSummary> {
  const captures = options?.captures ?? listCaptures();
  const plan = planExport(captures);
  const total = plan.items.length;
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];

  options?.onProgress?.({ done: 0, total, copied, skipped, failed });

  for (let i = 0; i < plan.items.length; i++) {
    const item = plan.items[i];
    try {
      if (item.kind === 'copy') {
        const outcome = await copyItem(item, destination);
        if (outcome === 'copied') copied += 1;
        else skipped += 1;
      } else {
        await writeJsonItem(item, destination);
        copied += 1;
      }
    } catch (e) {
      failed += 1;
      errors.push(`${item.destName}: ${errorMessage(e)}`);
    }
    options?.onProgress?.({
      done: i + 1,
      total,
      copied,
      skipped,
      failed,
      current: item.destName,
    });
  }

  return { total, copied, skipped, failed, errors };
}

/** Prompts the user for a destination folder and exports all captures. Returns undefined if cancelled. */
export async function pickAndExportCaptures(options?: {
  captures?: readonly Capture[];
  onProgress?: (progress: ExportProgress) => void;
}): Promise<ExportSummary | undefined> {
  let destination: Directory;
  try {
    destination = await Directory.pickDirectoryAsync();
  } catch (e) {
    if (isCancelledError(e)) return undefined;
    throw e;
  }
  return exportToDirectory(destination, options);
}
