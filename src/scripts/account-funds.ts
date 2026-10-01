import { executeAccountFunds, preflightAccountFunds, FUNDS_FAILURE } from '../accounts/account-funds-runtime.js';
import { readIdentityStdin, identityDiagnostic, writeIdentityDiagnostic, type IdentityDiagnosticStage } from '../accounts/account-identity-runtime.js';
process.umask(0o077);
let raw: Buffer | undefined, stage: IdentityDiagnosticStage = 'preflight';
try {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error();
  await preflightAccountFunds(); stage = 'credentials';
  raw = await readIdentityStdin(process.stdin);
  const result = await executeAccountFunds(raw);
  if (!result.success && result.diagnostic) await writeIdentityDiagnostic(result.diagnostic).catch(() => {});
  if (result.output !== null) process.stdout.write(result.output + '\n');
  process.exitCode = result.success ? 0 : 1;
} catch (error) {
  await writeIdentityDiagnostic(identityDiagnostic(stage, error)).catch(() => {});
  process.stdout.write(JSON.stringify(FUNDS_FAILURE) + '\n'); process.exitCode = 1;
} finally { raw?.fill(0); process.stdin.pause(); }
