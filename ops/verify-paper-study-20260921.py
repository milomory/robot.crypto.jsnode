#!/usr/bin/env python3
"""Read-only Hyperion acceptance; run once after the bounded capture has stopped.

Usage: python3 ops/verify-paper-study-20260921.py NEW_LOCAL_DIRECTORY
Exit 75 means the collector is still running. No polling/retry or remote writes.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

if not __debug__:
    print('Python optimization is unsupported for acceptance checks.', file=sys.stderr)
    raise SystemExit(1)

REPO = Path(__file__).resolve().parent.parent
HOST = 'hyperion-trading'
ARCHIVE = '/home/mil/crypto-study-30m-20260921/data/capture'
REMOTE = r'''
import hashlib, json, pathlib, stat, subprocess
if not __debug__: raise SystemExit(1)
root=pathlib.Path('/home/mil/crypto-study-30m-20260921/data/capture')
p=subprocess.run(['docker','inspect','crypto-study-30m-20260921','robot_crypto_jsnode'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
assert p.returncode==0,'inspect-failed'
collector,app=json.loads(p.stdout.decode())
assert collector['Id']=='d0975c5d59ad1d87a94209f488bd0ca4922ba9516e749e4ba92d604efa3ba754','collector-replaced'
s=collector['State']; h=collector['HostConfig']
assert app['State']['Status']=='running' and app['State']['StartedAt']=='2026-09-20T07:06:47.864812714Z','app-baseline-changed'
assert any(m['Destination']=='/code' and m['Source']=='/home/mil/robot.crypto.jsnode/releases/386ee2c1734af87f76ab3745b1076739cd5195f4' for m in app['Mounts']),'app-release-changed'
assert collector['Image']=='sha256:404c49b93e47f2eacecd16448ad73e021bf7f5edb621721f545667e8a58e9c08','image-changed'
assert collector['Config']['User']=='1002:27' and h['ReadonlyRootfs'] and h['RestartPolicy']['Name']=='no','isolation-changed'
assert h['Memory']==134217728 and h['NanoCpus']==500000000 and h['PidsLimit']==64 and 'ALL' in h['CapDrop'],'limits-changed'
assert 'no-new-privileges' in h['SecurityOpt'] and not collector['NetworkSettings']['Ports'],'security-changed'
assert sorted((m['Source'],m['Destination'],m['RW']) for m in collector['Mounts'])==[
 ('/home/mil/crypto-study-30m-20260921/collect.mjs','/lab/collect.mjs',False),
 ('/home/mil/crypto-study-30m-20260921/data','/data',True)],'mounts-changed'
if s['Status']=='running':
 print(json.dumps({'ready':False,'status':'running','startedAt':s['StartedAt']})); raise SystemExit(0)
assert s['Status']=='exited' and s['ExitCode']==0 and not s['OOMKilled'] and collector['RestartCount']==0,'collector-not-cleanly-completed'
assert root.is_dir() and not root.is_symlink(),'invalid-archive'
names=['manifest.json','state.json']+['%03d.json'%i for i in range(60)]
assert sorted(p.name for p in root.iterdir())==sorted(names),'incomplete-file-set'
hashes={}
for name in names:
 f=root/name; st=f.lstat()
 assert stat.S_ISREG(st.st_mode) and st.st_size<=128*1024,'invalid-file'
 data=f.read_bytes(); assert len(data)<=128*1024,'oversized-file'
 hashes[name]=hashlib.sha256(data).hexdigest()
state=json.loads((root/'state.json').read_text())
assert state['status']=='completed','capture-not-completed'
assert state['captureId']=='46c37b0f-2fa7-41ce-8e11-6c5c2d9e1bed','capture-replaced'
raw=(root.parent.parent/'collect.mjs').read_bytes()
assert hashlib.sha256(raw).hexdigest()=='4a7bce29a715ff5ea6ce7ee6ba14ce2516a9523c25bd1d111621e8aa9e16dbf5','bundle-changed'
print(json.dumps({'ready':True,'files':hashes,'state':state,'sourceRevision':'4b2dedea5958e62f594945214a1154d0f8f4eff2',
 'bundleSha256':hashlib.sha256(raw).hexdigest(),'collector':{'name':'crypto-study-30m-20260921','status':s['Status'],'exitCode':s['ExitCode'],'startedAt':s['StartedAt'],'finishedAt':s['FinishedAt'],'oomKilled':s['OOMKilled'],'restarts':collector['RestartCount']},'appUnchanged':True}))
'''


def checked(args, *, input_text=None, timeout=60):
    p = subprocess.run(args, input=input_text, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, text=True, timeout=timeout, cwd=REPO)
    if p.returncode:
        raise RuntimeError('verification-command-failed')
    return p.stdout


def hashes(directory):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(directory.iterdir()) if p.is_file() and not p.is_symlink()}


def main():
    if len(sys.argv) != 2:
        print('usage: verify-paper-study-20260921.py NEW_LOCAL_DIRECTORY', file=sys.stderr)
        return 1
    output = Path(sys.argv[1]).absolute()
    if os.path.lexists(output) or not output.parent.is_dir() or output.parent.is_symlink():
        raise RuntimeError('invalid-new-destination')
    evidence = json.loads(checked(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                                  HOST, 'python3', '-'], input_text=REMOTE, timeout=30))
    if not evidence['ready']:
        print(json.dumps(evidence))
        return 75
    expected = set(['manifest.json', 'state.json'] + ['%03d.json' % i for i in range(60)])
    assert set(evidence['files']) == expected
    output.mkdir(mode=0o700)
    archive = output / 'archive'
    archive.mkdir(mode=0o700)
    checked(['scp', '-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'] +
            [HOST + ':' + ARCHIVE + '/' + name for name in sorted(expected)] + [str(archive) + '/'])
    assert set(p.name for p in archive.iterdir()) == expected
    assert all(p.is_file() and not p.is_symlink() and p.stat().st_size <= 128 * 1024 for p in archive.iterdir())
    assert hashes(archive) == evidence['files']
    replay_revision = checked(['git', 'rev-parse', 'HEAD']).strip()
    assert not checked(['git', 'diff', '--name-only', '4b2dedea5958e62f594945214a1154d0f8f4eff2', '--', 'src/paper-v2', 'src/market-exact', 'src/scripts/paper-study.ts', 'src/scripts/paper-v2.ts', 'tsconfig.json', 'package.json', 'package-lock.json']).strip()
    checked(['npm', 'run', '--silent', 'build:api'])
    checked(['node', 'dist/scripts/paper-study.js', str(archive), str(output / 'study')])
    checked(['node', 'dist/scripts/paper-v2.js', str(output / 'study/scenario.json'), str(output / 'standalone')])
    result_bytes = (output / 'study/result.json').read_bytes()
    assert result_bytes == (output / 'standalone/result.json').read_bytes()
    assert hashes(archive) == evidence['files']
    result = json.loads(result_bytes)
    report = json.loads((output / 'study/study.json').read_text())
    assert report['eligibility'] == {'eligible': True, 'reason': 'validated-complete-declared-archive'}
    assert result['period']['uniqueSteps'] == 60 and len(report['decisions']) == 60
    assert result['executionPolicy'] == 'lagged-sma-3-6-v1'
    assert result['strategy']['finalAccount']['reconciled']
    # Incomplete valuation/failed benchmark is a valid negative finding, never filtered out.
    paths = [result['strategy'], result['benchmarks']['baseline'], result['benchmarks']['buyAndHold']]
    assert all(path['performance']['expectedPoints'] == 61 for path in paths)
    result_hash = hashlib.sha256(result_bytes).hexdigest()
    assert report['resultSha256'] == result_hash
    final_remote = json.loads(checked(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                                      HOST, 'python3', '-'], input_text=REMOTE, timeout=30))
    assert final_remote['ready'] and final_remote['files'] == evidence['files']
    evidence.update({'sourceArchive': ARCHIVE, 'replayRevision': replay_revision, 'replaySourceMatchesDeclaredRevision': True, 'copiedFilesMatch': True,
                     'localRawArchiveUnchanged': True, 'remoteRawArchiveUnchanged': True, 'independentReplayBytesIdentical': True,
                     'resultSha256': result_hash, 'datasetHash': result['marketData']['datasetHash'],
                     'captureId': result['marketData']['captureId'], 'period': result['period'],
                     'eligibility': report['eligibility'], 'comparison': result['comparison'],
                     'performance': report['performance'], 'counts': report['counts'],
                     'finalAccount': report['finalAccount'], 'completedAcceptance': True})
    fd = os.open(output / 'acceptance.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(json.dumps(evidence, indent=2) + '\n')
        f.flush()
        os.fsync(f.fileno())
    print(json.dumps({'completedAcceptance': True, 'captureId': evidence['captureId'],
                      'independentReplayBytesIdentical': True,
                      'comparable': result['comparison']['comparable'],
                      'counts': report['counts'], 'performance': report['performance']}))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('Paper study verification failed; preserve inputs and any partial local output.', file=sys.stderr)
        raise SystemExit(1)
