#!/usr/bin/python3 -I
"""Fixed Hyperion crypto.robot.vpn TLS deployment and certificate renewal."""
import datetime
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys

TLS = Path('/etc/crypto-robot/tls')
SITE = Path('/etc/nginx/sites-available/crypto.robot.vpn')
ENABLED = Path('/etc/nginx/sites-enabled/crypto.robot.vpn')
ALLOW = ['157.22.184.131', '185.9.27.65', '77.238.234.74', '38.54.13.221', '127.0.0.1', '::1']

def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

def write(path, text, mode=0o644):
    path = Path(path)
    temp = path.with_name(path.name + '.crypto-robot-new')
    if temp.exists() or temp.is_symlink():
        raise RuntimeError('staging path occupied')
    with temp.open('x') as handle:
        handle.write(text)
    temp.chmod(mode)
    temp.replace(path)

def main():
    if os.geteuid() != 0:
        raise RuntimeError('root required')
    os.umask(0o077)
    renew = sys.argv[1:] == ['--renew']
    if sys.argv[1:] and not renew:
        raise RuntimeError('unsupported arguments')
    if renew and subprocess.run(['openssl', 'x509', '-checkend', '2592000', '-noout', '-in', str(TLS / 'server.crt')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup = Path('/root/crypto-robot-backups') / stamp
    backup.mkdir(parents=True, mode=0o700)
    if TLS.exists():
        shutil.copytree(TLS, backup / 'tls')
    for path in [SITE, ENABLED]:
        if path.exists() or path.is_symlink():
            if path == ENABLED:
                if not path.is_symlink() or path.resolve() != SITE:
                    raise RuntimeError('unexpected existing crypto.robot.vpn enabled entry')
            else:
                if path.is_symlink():
                    raise RuntimeError('unexpected site symlink')
                shutil.copy2(path, backup / 'nginx.before')
    old_enabled = ENABLED.is_symlink()
    if not renew:
        existing = SITE.read_text()
        if set(re.findall(r'allow\s+([^;]+);', existing)) != {'157.22.184.131', '38.54.13.221', '185.9.27.65', '127.0.0.1'} or 'deny all;' not in existing:
            raise RuntimeError('unexpected existing ACL')
    TLS.mkdir(parents=True, exist_ok=True, mode=0o700)
    TLS.chmod(0o700)
    ca_key = TLS / 'ca.key'
    ca_cert = TLS / 'ca.crt'
    if not ca_key.exists():
        if renew or ca_cert.exists():
            raise RuntimeError('existing CA key unavailable')
        run('openssl', 'genrsa', '-out', str(ca_key), '3072')
    # Explicit config avoids duplicate extensions from the host OpenSSL defaults.
    repair_ca = not ca_cert.exists()
    if ca_cert.exists():
        details = run('openssl', 'x509', '-in', str(ca_cert), '-noout', '-text')
        repair_ca = details.count(b'X509v3 Basic Constraints:') != 1
    if repair_ca:
        write(TLS / 'ca.cnf', '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Crypto Robot VPN Root CA\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:crypto.robot.vpn\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid:always\n')
        run('openssl', 'req', '-x509', '-new', '-sha256', '-key', str(ca_key),
            '-out', str(ca_cert), '-days', '3650', '-config', str(TLS / 'ca.cnf'))
    stage = TLS / ('stage-' + stamp)
    stage.mkdir(mode=0o700)
    run('openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=crypto.robot.vpn',
        '-keyout', str(stage / 'server.key'), '-out', str(stage / 'server.csr'))
    write(stage / 'leaf.ext', 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:crypto.robot.vpn\n')
    run('openssl', 'x509', '-req', '-in', str(stage / 'server.csr'), '-CA', str(TLS / 'ca.crt'),
        '-CAkey', str(TLS / 'ca.key'), '-set_serial', '0x' + os.urandom(16).hex(),
        '-out', str(stage / 'server.crt'), '-days', '90', '-sha256', '-extfile', str(stage / 'leaf.ext'))
    run('openssl', 'verify', '-CAfile', str(TLS / 'ca.crt'), '-verify_hostname', 'crypto.robot.vpn', str(stage / 'server.crt'))
    for name in ['server.key', 'server.crt']:
        (stage / name).replace(TLS / name)
    shutil.rmtree(stage)
    config = '# Prepared for review; not installed. Dedicated certificate/renewal required.\n# Preserve current Crypto VPN egress allowlist; reconcile with Auth before SSO.\nserver {\n    listen 80;\n    listen [::]:80;\n    server_name crypto.robot.vpn;\n    access_log off;\n    error_log /dev/null;\n    # Never forward a code received over plaintext HTTP.\n    location = /auth/callback { return 400; }\n    location / { return 308 https://crypto.robot.vpn$uri; }\n}\n\nserver {\n    listen 443 ssl;\n    listen [::]:443 ssl;\n    server_name crypto.robot.vpn;\n    ssl_certificate /etc/crypto-robot/tls/server.crt;\n    ssl_certificate_key /etc/crypto-robot/tls/server.key;\n    ssl_protocols TLSv1.2 TLSv1.3;\n\n    # Callback codes may appear in request context of nginx error messages too.\n    # Do not log requests for this small private vhost; use metrics/health probes.\n    access_log off;\n    error_log /dev/null;\n    client_max_body_size 16k;\n    allow 157.22.184.131;\n    allow 38.54.13.221;\n    allow 185.9.27.65;\n    allow 127.0.0.1;\n    deny all;\n\n    location / {\n        proxy_pass http://127.0.0.1:5758;\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $remote_addr;\n        proxy_set_header X-Forwarded-Proto $scheme;\n        proxy_set_header Connection "";\n        proxy_connect_timeout 5s;\n        proxy_read_timeout 20s;\n    }\n}\n'
    try:
        if not renew:
            write(SITE, config)
            if not old_enabled:
                ENABLED.symlink_to(SITE)
        run('/usr/sbin/nginx', '-t')
        run('systemctl', 'reload', 'nginx')
    except Exception:
        if (backup / 'tls/server.crt').exists():
            for name in ['server.crt', 'server.key']:
                shutil.copy2(backup / 'tls' / name, TLS / name)
        if not renew:
            if (backup / 'nginx.before').exists():
                shutil.copy2(backup / 'nginx.before', SITE)
            else:
                SITE.unlink() if SITE.exists() else None
            if not old_enabled:
                ENABLED.unlink() if ENABLED.is_symlink() else None
        raise
    public = Path('/home/mil/robot.crypto.jsnode/crypto-robot-vpn-root-ca.crt')
    shutil.copyfile(TLS / 'ca.crt', public)
    public.chmod(0o644)
    if not renew:
        write('/usr/local/sbin/crypto-robot-tls-maintain', SOURCE, 0o700)
        write('/etc/systemd/system/crypto-robot-tls-renew.service', '[Unit]\nDescription=Renew crypto.robot.vpn private TLS certificate\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/crypto-robot-tls-maintain --renew\n')
        write('/etc/systemd/system/crypto-robot-tls-renew.timer', '[Unit]\nDescription=Check crypto.robot.vpn TLS expiry daily\n[Timer]\nOnCalendar=daily\nRandomizedDelaySec=1h\nPersistent=true\n[Install]\nWantedBy=timers.target\n')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', '--now', 'crypto-robot-tls-renew.timer')
    result = {'ok': True, 'backup': str(backup), 'domain': 'crypto.robot.vpn', 'ca_fingerprint': run('openssl', 'x509', '-in', str(TLS / 'ca.crt'), '-noout', '-fingerprint', '-sha256').decode().strip()}
    write('/home/mil/robot.crypto.jsnode/tls-status.json', json.dumps(result) + '\n')
    print(json.dumps(result))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'ok': False, 'error': 'crypto-robot-tls-operation-failed'}))
        sys.exit(1)
