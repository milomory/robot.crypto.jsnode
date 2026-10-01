/** Fixed-path protected one-venue read. No key lookup, server bootstrap, journal import or exchange mutation. */
import { executeProtectedOrderRecovery, PROTECTED_RECOVERY_FAILURE, readOrderRecoveryStdin } from '../accounts/order-recovery-runtime.js';
import { preflightProtectedOrderRecovery } from '../live/order-recovery-request.js';

let raw: Buffer | undefined;
try {
  const args = process.argv.slice(2);
  if ((args.length !== 2 && args.length !== 3) || args[0] !== '--request-digest' || !/^[a-f0-9]{64}$/.test(args[1]) ||
      (args.length === 3 && args[2] !== '--preflight')) throw new Error();
  const preflight = await preflightProtectedOrderRecovery(args[1]);
  if (args.length === 3) console.log(JSON.stringify(preflight.summary));
  else {
    raw = await readOrderRecoveryStdin(process.stdin);
    const result = await executeProtectedOrderRecovery(args[1], raw);
    if (result.output !== null) console.log(result.output);
    if (!result.success) process.exitCode = 1;
  }
} catch {
  console.log(JSON.stringify(PROTECTED_RECOVERY_FAILURE)); process.exitCode = 1;
} finally { raw?.fill(0); }
