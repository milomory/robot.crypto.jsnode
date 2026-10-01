#!/usr/bin/env python3
"""Launch one isolated, bounded public probe. No private exchange API requests.

Usage: run-pair-paper-probe.py [--study-30m|--study-24h] BUILT_BUNDLE NEW_LOCAL_EVIDENCE_DIRECTORY
Only creates a new lab directory/container. Existing application is not restarted.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone
from pair_paper_profiles import launch_arguments, profile_limits

HOST = 'hyperion-trading'
IMAGE = 'sha256:404c49b93e47f2eacecd16448ad73e021bf7f5edb621721f545667e8a58e9c08'
APP_FORMAT = '{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}},"status":{{json .State.Status}},"restarts":{{json .RestartCount}}}'

def checked(args, input_text=None, timeout=35):
    result = subprocess.run(args, input=input_text, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('probe-command-failed; inspect preserved evidence, no automatic retry')
    return result.stdout.strip()

def remote(script):
    return checked(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', HOST, 'python3 -'], script)

def main():
    profile, args = launch_arguments(sys.argv[1:])
    limits = profile_limits(profile)
    watchdog, command = limits['watchdog'], limits['command']
    bundle = Path(args[0]).absolute()
    evidence = Path(args[1]).absolute()
    if bundle.is_symlink() or not bundle.is_file() or bundle.stat().st_size > 2 * 1024 * 1024:
        raise RuntimeError('invalid-bundle')
    digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    revision = checked(['git', 'rev-parse', 'HEAD'])
    if checked(['git', 'status', '--porcelain', '--', 'src/paper-pair', 'src/scripts/pair-paper.ts',
                'src/market-exact/archive.ts', 'src/paper-v2/ledger.ts', 'ops/run-pair-paper-probe.py',
                'ops/verify-pair-paper-probe.py', 'ops/pair_paper_profiles.py']):
        raise RuntimeError('commit-probe-source-before-launch')
    name = 'crypto-pair-paper-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + digest[:8]
    if not re.fullmatch(r'crypto-pair-paper-[0-9TZ]+-[a-f0-9]{8}', name):
        raise RuntimeError('invalid-run-name')
    root = '/home/mil/' + name
    os.umask(0o077)
    evidence.mkdir(mode=0o700)
    prepare = '''import json, os, pathlib, shutil, subprocess, time
os.umask(0o077)
root=pathlib.Path(ROOT)
if os.getuid()!=1002 or os.getgid()!=27: raise RuntimeError('wrong-operator')
if shutil.disk_usage('/home/mil').free<LIMITS['minimumFreeBytes']: raise RuntimeError('insufficient-free-space')
running=subprocess.check_output(['docker','ps','--format','{{.Names}}']).decode().splitlines()
if any(name.startswith('crypto-pair-paper-') for name in running): raise RuntimeError('another-pair-lab-running')
app=json.loads(subprocess.check_output(['docker','inspect','--format',APP_FORMAT,'robot_crypto_jsnode']).decode())
if app['status']!='running': raise RuntimeError('app-not-running')
subprocess.check_call(['docker','image','inspect',IMAGE],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
root.mkdir(mode=0o700)
(root/'data').mkdir(mode=0o700)
r=json.loads(pathlib.Path('/home/mil/crypto-pair-observer/state/current.json').read_text())
now=int(time.time()*1000)
if not isinstance(r.get('checkedAt'),int) or not 0<=now-r['checkedAt']<=600000: raise RuntimeError('stale-fees')
f={'checkedAt':r['checkedAt'],'fees':{}}
for v in ['mexc','okx']:
 a=r.get('accounts',{}).get(v,{})
 if a.get('status')!='available' or a.get('feeReadVerified') is not True: raise RuntimeError('fee-unavailable')
 fee=a.get('fees',{})
 f['fees'][v]={k:a.get(k) for k in ['status','feeReadVerified','requestedAt','receivedAt']}
 f['fees'][v].update({k:fee.get(k) for k in ['takerRate','ratePrecision','rateConvention']})
mexc=r['accounts']['mexc']; okx=r['accounts']['okx']
payment=mexc.get('feePayment',{})
mx=payment.get('mxDeductEnabled') if payment.get('readVerified') is True else None
mode=okx.get('permissions',{}).get('feeType')
f['paymentModes']={'observedAt':min(mexc['receivedAt'],okx['receivedAt']),
 'mexcMxDeduct':mx if isinstance(mx,bool) else None,'okxFeeType':mode if mode in ['0','1'] else None}
(root/'fees.json').write_text(json.dumps(f)+'\\n')
(root/'app-before.json').write_text(json.dumps(app)+'\\n')
print(json.dumps({'appBefore':app,'feeProjectionReady':True}))
'''
    prefix = 'ROOT=' + repr(root) + '\nAPP_FORMAT=' + repr(APP_FORMAT) + '\nIMAGE=' + repr(IMAGE) + '\nLIMITS=' + repr(limits) + '\n'
    before = json.loads(remote(prefix + prepare))
    checked(['scp', '-q', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', str(bundle), HOST + ':' + root + '/pair-paper.mjs'])
    launch = '''import fcntl,hashlib,json,os,pathlib,shutil,stat,subprocess
root=pathlib.Path(ROOT)
lock=os.open('/home/mil/.crypto-pair-paper-launch.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
lock_stat=os.fstat(lock)
if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_uid!=os.getuid() or lock_stat.st_mode&0o777!=0o600: raise RuntimeError('invalid-launch-lock')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
if shutil.disk_usage('/home/mil').free<LIMITS['minimumFreeBytes']: raise RuntimeError('insufficient-free-space')
running=subprocess.check_output(['docker','ps','--format','{{.Names}}']).decode().splitlines()
if any(name.startswith('crypto-pair-paper-') for name in running): raise RuntimeError('another-pair-lab-running')
if hashlib.sha256((root/'pair-paper.mjs').read_bytes()).hexdigest()!=DIGEST: raise RuntimeError('bundle-mismatch')
os.chmod(str(root/'pair-paper.mjs'),0o600)
args=['docker','run','--detach','--name',NAME,'--pull','never','--user','1002:27','--read-only',
 '--cap-drop','ALL','--security-opt','no-new-privileges','--memory','128m','--cpus','0.5','--pids-limit','64',
 '--restart','no','--log-driver','none',
 '--mount','type=bind,src='+str(root/'pair-paper.mjs')+',dst=/lab/pair-paper.mjs,readonly',
 '--mount','type=bind,src='+str(root/'fees.json')+',dst=/lab/fees.json,readonly',
 '--mount','type=bind,src='+str(root/'data')+',dst=/data',IMAGE,
 'timeout','--signal=TERM','--kill-after=10s',WATCHDOG,'node','/lab/pair-paper.mjs',COMMAND,'/lab/fees.json','/data/archive']
container=subprocess.check_output(args,stderr=subprocess.DEVNULL).decode().strip()
print(json.dumps({'container':container,'name':NAME,'remoteRoot':ROOT,'image':IMAGE,'bundleSha256':DIGEST}))
'''
    started = json.loads(remote(prefix + 'WATCHDOG=' + repr(watchdog) + '\nCOMMAND=' + repr(command) + '\nDIGEST=' + repr(digest) + '\nNAME=' + repr(name) + '\n' + launch))
    info = dict(started, sourceRevision=revision, profile=profile, limits=limits, **before)
    (evidence / 'launch.json').write_text(json.dumps(info, indent=2) + '\n')
    print(json.dumps(info))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Bounded probe launch failed; retain its new directory. No automatic retry.', file=sys.stderr)
        sys.exit(1)
