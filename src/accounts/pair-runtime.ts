import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AccountError } from './types.js';
import { AccountCredentialBundle } from './credentials.js';

export type Cooldowns = { schema: 1; mexc: number; okx: number };
export function parsePairInput(raw: Buffer) {
  try {
    if (!raw.length || raw.length > 40 * 1024) throw new Error();
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || Object.keys(value).sort().join(',') !== 'mexc,okx,schema' || value.schema !== 1) throw new Error();
    const mexc = AccountCredentialBundle.parse(JSON.stringify(value.mexc));
    const okx = AccountCredentialBundle.parse(JSON.stringify(value.okx));
    if (mexc.venue !== 'mexc' || okx.venue !== 'okx') throw new Error();
    const secrets: string[] = [value.mexc.apiKey, value.mexc.apiSecret, value.okx.apiKey, value.okx.apiSecret, value.okx.passphrase];
    return { mexc, okx, assertNoSecrets(text: string) {
      if (secrets.some(secret => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1)))) {
        throw new Error('observer-output-rejected');
      }
    } };
  } catch { throw new Error('observer-invalid-input'); }
}

async function privateDirectory(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.()) {
    throw new Error('observer-private-directory-required');
  }
}
export async function writePrivateJson(directory: string, name: 'current.json' | 'cooldowns.json', value: unknown) {
  await privateDirectory(directory);
  const path = join(directory, name), temporary = join(directory, `.${name}.${randomUUID()}`);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('observer-private-file-required'); }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > (name === 'current.json' ? 512 : 256) * 1024) throw new Error('observer-report-too-large');
  let created = false;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); created = false;
  } finally { if (created) await unlink(temporary).catch(() => {}); }
}
export async function loadCooldowns(directory: string): Promise<Cooldowns> {
  await privateDirectory(directory);
  let file;
  try { file = await open(join(directory, 'cooldowns.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1, mexc: 0, okx: 0 };
    throw new Error('observer-invalid-cooldowns');
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error();
    const value = JSON.parse(await file.readFile('utf8'));
    if (!value || Object.keys(value).sort().join(',') !== 'mexc,okx,schema' || value.schema !== 1 ||
        [value.mexc, value.okx].some(n => !Number.isSafeInteger(n) || n < 0 || n > 8_640_000_000_000_000)) throw new Error();
    return value;
  } catch { throw new Error('observer-invalid-cooldowns'); }
  finally { await file.close(); }
}

// Private/public calls share persisted venue backoff across separate scheduled processes.
// Only status + Retry-After metadata are observed; request URLs/headers are never stored.
export function persistentFetch(state: Cooldowns, save: () => Promise<void>, request: typeof fetch = fetch, clock = Date.now): typeof fetch {
  let pendingSave = Promise.resolve();
  const saveSerially = () => {
    const next = pendingSave.then(save);
    pendingSave = next.catch(() => {});
    return next;
  };
  return async (input, init) => {
    let url: URL;
    try { url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); }
    catch { throw new AccountError('account-unsupported-endpoint'); }
    const venue = url.origin === 'https://api.mexc.com' ? 'mexc' : url.origin === 'https://www.okx.com' ? 'okx' : null;
    if (!venue || init?.method !== 'GET' || url.username || url.password || url.hash || url.port) throw new AccountError('account-unsupported-endpoint');
    const now = clock();
    if (!Number.isSafeInteger(now) || now <= 0) throw new AccountError('account-invalid-clock');
    if (state[venue] > now) throw new AccountError('account-rate-limited');
    const response = await request(input, init);
    if (init.signal?.aborted) { void response.body?.cancel().catch(() => {}); throw new AccountError('account-timeout'); }
    if (response.status === 418 || response.status === 429) {
      const received = clock();
      if (!Number.isSafeInteger(received) || received < now) { void response.body?.cancel().catch(() => {}); throw new AccountError('account-invalid-clock'); }
      const raw = response.headers.get('retry-after');
      let until = received + 60_000;
      if (raw && /^\d+(?:\.\d+)?$/.test(raw)) until = Math.max(until, received + Number(raw) * 1000);
      else if (raw && Number.isFinite(Date.parse(raw))) until = Math.max(until, Date.parse(raw));
      state[venue] = Math.min(8_640_000_000_000_000, Math.ceil(Math.max(state[venue], until)));
      try { await saveSerially(); } catch { void response.body?.cancel().catch(() => {}); throw new AccountError('account-unavailable'); }
    }
    return response;
  };
}
