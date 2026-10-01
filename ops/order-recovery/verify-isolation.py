#!/usr/bin/python3 -I
"""Read-only metadata proof; never print configs, environment or credential values."""
import hashlib,json,os,subprocess,sys
from pathlib import Path

def command(argv, input=None):
    return subprocess.run(argv,input=input,stdin=subprocess.DEVNULL if input is None else None,
        stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=25,check=True).stdout

def main():
    if os.geteuid()!=0 or len(sys.argv)!=1: raise ValueError()
    targets=['/etc/agent-secrets/athena-registry.json','/etc/agent-secrets/athena-broker.json',
        '/opt/crypto-pair-observer/manifest.json','/opt/crypto-pair-observer/ops/pair-observer/release-pin.json',
        '/etc/systemd/system/crypto-pair-observer.service','/etc/systemd/system/crypto-pair-observer.timer']
    hashes={p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in targets}
    timer=command(['/usr/bin/systemctl','show','--property=ActiveState','--value','crypto-pair-observer.timer']).decode().strip()
    remote=r'''
import json,subprocess
from pathlib import Path
fmt='{"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}}}'
p=subprocess.run(['/usr/bin/docker','inspect','--format',fmt,'robot_crypto_jsnode'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10,check=True)
container=json.loads(p.stdout)
p=subprocess.run(['/usr/bin/docker','inspect','--format',fmt,'pg-crypto-robot'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10,check=True)
database=json.loads(p.stdout)
p=subprocess.run(['/usr/bin/docker','ps','--all','--quiet','--no-trunc','--filter','name=^/crypto-order-recovery-readonly$'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10,check=True)
print(json.dumps({'robot':container,'database':database,'recoveryContainerAbsent':not bool(p.stdout.strip())}))
'''
    remote=json.loads(command(['/usr/bin/sudo','-n','-u','anton','/usr/bin/ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','hyperion-trading','python3 -'],remote.encode()))
    print(json.dumps({'schema':1,'localHashes':hashes,'observerTimer':timer,'remote':remote},sort_keys=True))
if __name__=='__main__':
    try:main()
    except Exception:
        print('{"schema":1,"error":"isolation-check-failed"}');sys.exit(1)
