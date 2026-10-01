import { constants } from 'node:fs';
import { lstat, open, readdir, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExecutionHistoryCapture } from './execution-history.js';

/** Private economic data only. Refuse overwrites, unsafe directories and credential-bearing content. */
export async function writeExecutionCapture(directory: string, capture: ExecutionHistoryCapture, assertNoSecrets: (text: string) => void) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(capture.captureId)) throw new Error('history-invalid-capture-id');
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)) throw new Error('history-private-directory-required');
  const existing = await readdir(directory);
  if (existing.filter(name => name.startsWith('capture-')).length >= 20) throw new Error('history-archive-capacity');
  const text = JSON.stringify(capture) + '\n'; assertNoSecrets(text);
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('history-archive-too-large');
  const target = join(directory, `capture-${capture.captureId}.json`), temporary = join(directory, `.capture-${randomUUID()}`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await link(temporary, target);
  } finally { await unlink(temporary); }
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
