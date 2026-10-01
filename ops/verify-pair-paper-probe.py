#!/usr/bin/env python3
"""Read-only acceptance/copy for a finished public probe; no retries or remote writes.

Usage: verify-pair-paper-probe.py [--schedule-diagnostics ANALYZER_BUNDLE] LOCAL_EVIDENCE_DIRECTORY
Exit75 means still running; rerun after it finishes. Never overwrites local copies.
"""
import hashlib
import inspect
import io
import shlex
import tarfile
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import sys
import time
from pair_paper_profiles import inspect_archive, profile_limits
HOST = 'hyperion-trading'
APP_FORMAT = '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"status":{{json .State.Status}},"restarts":{{json .RestartCount}}}'
CAPTURE_FORMAT = '{"id":{{json .Id}},"image":{{json .Image}},"state":{{json .State}},"restarts":{{json .RestartCount}},"user":{{json .Config.User}},"command":{{json .Config.Cmd}},"host":{{json .HostConfig}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}}}'

def checked(args, input_text=None):
    p = subprocess.run(args, input=input_text, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=40)
    if p.returncode:
        raise RuntimeError('verification-command-failed')
    return p.stdout

def read_bounded_stream(args, max_bytes=48 * 1024 * 1024, timeout=120):
    """Read only this child's stdout with live byte/deadline limits and safe errors."""
    if (isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 1 or
            isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout < float('inf')):
        raise RuntimeError('invalid-stream-limits')
    deadline = time.monotonic() + timeout
    process = None
    selector = selectors.DefaultSelector()
    try:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL)
        os.set_blocking(process.stdout.fileno(), False)
        selector.register(process.stdout, selectors.EVENT_READ)
        chunks, total = [], 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('archive-stream-timeout')
            if not selector.select(remaining):
                continue
            try:
                # At the limit, read just one sentinel byte to distinguish EOF
                # from oversized output without buffering the remaining stream.
                chunk = os.read(process.stdout.fileno(), min(65536, max_bytes - total + 1))
            except BlockingIOError:
                continue
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise RuntimeError('archive-stream-too-large')
            chunks.append(chunk)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('archive-stream-timeout')
        try:
            code = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            raise RuntimeError('archive-stream-timeout') from None
        if code:
            raise RuntimeError('archive-stream-failed')
        return b''.join(chunks)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise RuntimeError('archive-stream-failed') from None
    finally:
        selector.close()
        if process is not None:
            try:
                if process.poll() is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                process.wait()
            finally:
                process.stdout.close()

def main():
    args = sys.argv[1:]
    diagnostic_bundle = None
    if args[:1] == ['--schedule-diagnostics']:
        if len(args) != 3:
            raise RuntimeError('expected diagnostic bundle and evidence directory')
        diagnostic_bundle, args = Path(args[1]).absolute(), args[2:]
    if len(args) != 1:
        raise RuntimeError('expected evidence directory')
    root = Path(args[0]).absolute()
    launch = json.loads((root / 'launch.json').read_text())
    if not re.fullmatch(r'crypto-pair-paper-[0-9TZ]+-[a-f0-9]{8}', launch['name']):
        raise RuntimeError('invalid-run-name')
    if launch['remoteRoot'] != '/home/mil/' + launch['name'] or not re.fullmatch(r'[a-f0-9]{64}', launch['bundleSha256']):
        raise RuntimeError('invalid-run-path')
    limits = profile_limits(launch.get('profile', 'probe'))
    if 'limits' in launch and launch['limits'] != limits:
        raise RuntimeError('launch-limits-mismatch')
    script = '''import hashlib,json,pathlib,re,stat,subprocess
root=pathlib.Path(LAUNCH['remoteRoot'])
samples=LIMITS['samples']
watchdog=LIMITS['watchdog']
command=LIMITS['command']
def check(ok):
 if not ok: raise RuntimeError('acceptance-guard-failed')
app=json.loads(subprocess.check_output(['docker','inspect','--format',APP_FORMAT,'robot_crypto_jsnode']).decode())
check(app==LAUNCH['appBefore'])
c=json.loads(subprocess.check_output(['docker','inspect','--format',CAPTURE_FORMAT,LAUNCH['name']]).decode())
check(c['id']==LAUNCH['container'] and c['image']==LAUNCH['image'])
s=c['state']; h=c['host']
check(c['user']=='1002:27' and h['ReadonlyRootfs'] and h['RestartPolicy']['Name']=='no')
check(h['Memory']==134217728 and h['NanoCpus']==500000000 and h['PidsLimit']==64)
check('ALL' in h['CapDrop'] and 'no-new-privileges' in h['SecurityOpt'] and not c['ports'])
check(h['LogConfig']['Type']=='none' and c['restarts']==0)
check(sorted((m['Source'],m['Destination'],m['RW']) for m in c['mounts'])==sorted([
 (str(root/'pair-paper.mjs'),'/lab/pair-paper.mjs',False),
 (str(root/'fees.json'),'/lab/fees.json',False),(str(root/'data'),'/data',True)]))
check(c['command']==['timeout','--signal=TERM','--kill-after=10s',watchdog,'node','/lab/pair-paper.mjs',command,'/lab/fees.json','/data/archive'])
archive=root/'data/archive'
if s['Status']=='running':
 progress=inspect_archive(archive,LIMITS,running=True)
 print(json.dumps({'ready':False,'status':'running','appUnchanged':True,'isolationVerified':True,
  'expectedSamples':samples,'containerStartedAt':s['StartedAt'],**progress})); raise SystemExit(0)
check(s['Status']=='exited' and s['ExitCode']==0 and not s['OOMKilled'])
progress=inspect_archive(archive,LIMITS)
hashes=progress.pop('files')
check(hashlib.sha256((root/'pair-paper.mjs').read_bytes()).hexdigest()==LAUNCH['bundleSha256'])
terminal=json.loads((archive/'state.json').read_text()); check(terminal['status']=='completed')
print(json.dumps({'ready':True,'appUnchanged':True,'isolationVerified':True,'files':hashes,
 **progress,'captureId':terminal['captureId'],'collector':{'name':LAUNCH['name'],'status':s['Status'],'exitCode':s['ExitCode'],
 'startedAt':s['StartedAt'],'finishedAt':s['FinishedAt'],'oomKilled':s['OOMKilled'],'restarts':c['restarts']}}))
'''
    script = 'LAUNCH=' + repr(launch) + '\nAPP_FORMAT=' + repr(APP_FORMAT) + '\nCAPTURE_FORMAT=' + repr(CAPTURE_FORMAT) + '\nLIMITS=' + repr(limits) + '\n' + inspect.getsource(inspect_archive) + '\n' + script
    evidence = json.loads(checked(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', HOST, 'python3 -'], script))
    if not evidence['ready']:
        print(json.dumps(evidence))
        return 75
    os.umask(0o077)
    archive = root / 'archive'
    if archive.is_symlink() or (archive.exists() and not archive.is_dir()):
        raise RuntimeError('invalid-existing-copy')
    if not archive.exists():
        archive.mkdir(mode=0o700)
        # One bounded stream avoids one high-latency SFTP round trip per sample.
        command = shlex.join(['tar', '-C', launch['remoteRoot'] + '/data/archive', '-cf', '-', '--', *sorted(evidence['files'])])
        transfer = read_bounded_stream(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', HOST, command],
                                       max_bytes=limits['maxTransferBytes'], timeout=limits['transferTimeout'])
        received = {}
        with tarfile.open(fileobj=io.BytesIO(transfer), mode='r:') as stream:
            for member in stream:
                name = member.name
                if name not in evidence['files'] or name in received or not member.isfile() or not 0 < member.size <= limits['maxFileBytes']:
                    raise RuntimeError('invalid-archive-stream-member')
                data = stream.extractfile(member).read()
                if hashlib.sha256(data).hexdigest() != evidence['files'][name]:
                    raise RuntimeError('archive-stream-hash-mismatch')
                received[name] = data
        if set(received) != set(evidence['files']):
            raise RuntimeError('archive-stream-file-set-mismatch')
        # Only validated, allowlisted names; never extract archive paths or overwrite files.
        for name, data in received.items():
            with (archive / name).open('xb') as output:
                output.write(data)
    if set(p.name for p in archive.iterdir()) != set(evidence['files']):
        raise RuntimeError('copied-file-set-mismatch')
    for name, digest in evidence['files'].items():
        p = archive / name
        if p.is_symlink() or not p.is_file() or p.stat().st_size > limits['maxFileBytes'] or hashlib.sha256(p.read_bytes()).hexdigest() != digest:
            raise RuntimeError('copied-file-hash-mismatch')
    duplicate = root / 'repeat-report'
    bundle = root.parent / 'pair-paper.mjs'
    if bundle.is_symlink() or not bundle.is_file() or bundle.stat().st_size > 2 * 1024 * 1024 or hashlib.sha256(bundle.read_bytes()).hexdigest() != launch['bundleSha256']:
        raise RuntimeError('local-bundle-mismatch')
    analysis_command = 'report'
    analysis_evidence = {'analysisMode': 'strict', 'protocolAccepted': True}
    if diagnostic_bundle is not None:
        if diagnostic_bundle.is_symlink() or not diagnostic_bundle.is_file() or diagnostic_bundle.stat().st_size > 2 * 1024 * 1024:
            raise RuntimeError('invalid-diagnostic-bundle')
        strict_output = root / 'original-strict-replay'
        if strict_output.exists():
            raise RuntimeError('strict-output-already-exists')
        original = subprocess.run(['node', str(bundle), 'report', str(archive), str(strict_output)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=40)
        if original.returncode == 0 or strict_output.exists():
            raise RuntimeError('diagnostics-require-failed-original-strict-replay')
        if checked(['git', 'status', '--porcelain', '--', 'src/paper-pair', 'src/scripts/pair-paper.ts', 'ops/verify-pair-paper-probe.py', 'ops/pair_paper_profiles.py']).strip():
            raise RuntimeError('commit-diagnostic-source-first')
        bundle = diagnostic_bundle
        analysis_command = 'report-diagnostics'
        analysis_evidence = {'analysisMode': 'schedule-diagnostics', 'protocolAccepted': False,
            'originalStrictReplayPassed': False, 'analyzerRevision': checked(['git', 'rev-parse', 'HEAD']).strip(),
            'analyzerBundleSha256': hashlib.sha256(bundle.read_bytes()).hexdigest()}
    result = json.loads(checked(['node', 'dist/scripts/pair-paper.js', analysis_command, str(archive), str(root / 'report')]))
    checked(['node', str(bundle), analysis_command, str(archive), str(duplicate)])
    first = (root / 'report/report.json').read_bytes()
    if first != (duplicate / 'report.json').read_bytes():
        raise RuntimeError('nondeterministic-report')
    if any(hashlib.sha256((archive / n).read_bytes()).hexdigest() != d for n, d in evidence['files'].items()):
        raise RuntimeError('replay-changed-source')
    evidence.update({'sourceRevision': launch['sourceRevision'], 'bundleSha256': launch['bundleSha256'],
                     'reportSha256': hashlib.sha256(first).hexdigest(), 'deterministicReplay': True, 'report': result, **analysis_evidence})
    with (root / 'acceptance.json').open('x') as f:
        json.dump(evidence, f, indent=2)
        f.write('\n')
    print(json.dumps({k: v for k, v in evidence.items() if k != 'files'}))
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print('Probe acceptance failed; preserve all evidence. No automatic retry.', file=sys.stderr)
        sys.exit(1)
