import { executeAccountIdentity, IDENTITY_FAILURE, identityDiagnostic, preflightAccountIdentity, readIdentityStdin,
  writeIdentityDiagnostic, type IdentityDiagnosticStage } from '../accounts/account-identity-runtime.js';
process.umask(0o077);
let raw: Buffer | undefined;
let stage: IdentityDiagnosticStage = 'credentials';
try {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error();
  stage = 'preflight';
  await preflightAccountIdentity();
  stage = 'credentials';
  raw = await readIdentityStdin(process.stdin);
  const result = await executeAccountIdentity(raw);
  if (!result.success && result.diagnostic) await writeIdentityDiagnostic(result.diagnostic).catch(() => {});
  if (result.output !== null) process.stdout.write(result.output + '\n');
  process.exitCode = result.success ? 0 : 1;
} catch (error) {
  await writeIdentityDiagnostic(identityDiagnostic(stage, error)).catch(() => {});
  process.stdout.write(JSON.stringify(IDENTITY_FAILURE) + '\n'); process.exitCode = 1;
} finally { raw?.fill(0); process.stdin.pause(); }
