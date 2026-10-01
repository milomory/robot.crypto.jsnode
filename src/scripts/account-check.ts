import { AccountCredentialBundle } from '../accounts/credentials.js';
import { checkAccount } from '../accounts/check.js';

// Intended broker consumer: one JSON secret bundle on protected stdin, no file/argv/env input.
// Not wired to the application or a broker profile by installing this source file.
async function input() {
  let size = 0;
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => process.stdin.destroy(new Error('stdin-timeout')), 10_000);
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 16 * 1024) throw new Error();
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timer); }
}
try {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error();
  const bundle = AccountCredentialBundle.parse(await input());
  console.log(JSON.stringify(await checkAccount(bundle)));
} catch {
  console.error('Account credential check failed. No trading or transfer was attempted.');
  process.exitCode = 1;
}
