#!/usr/bin/env python3
"""Compile the fixed entrypoint and package only its static runtime import graph.

No credentials or identity observations are read or manufactured. Only this workflow's
release pin changes. The temporary build never overwrites the shared dist tree.
"""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile

REPO = Path(__file__).resolve().parents[2]
OUT = None
ENTRY = 'dist/scripts/account-funds.js'
MAX_FILES = 4096
MAX_TOTAL = 32 * 1024 * 1024
GRAPH = r'''
const fs=require('node:fs'),path=require('node:path'),ts=require(process.argv[2]+'/node_modules/typescript');
const built=path.resolve(process.argv[1]),repo=path.resolve(process.argv[2]),seen=new Set(),pending=['dist/scripts/account-funds.js','dist/scripts/account-funds-enroll.js'];
function physical(name){return name.startsWith('dist/')?path.join(built,name.slice(5)):path.join(repo,name)}
function secure(name){const target=physical(name),info=fs.lstatSync(target);if(!info.isFile()||info.nlink!==1||fs.realpathSync(target)!==target||info.size>8*1024*1024)throw Error('unsafe-build');return target;}
while(pending.length){const name=pending.pop();if(seen.has(name))continue;
if(!/^(?:dist\/accounts\/[A-Za-z0-9_-]+\.js|dist\/scripts\/account-funds(?:-enroll)?\.js|node_modules\/zod\/[A-Za-z0-9_./-]+\.js)$/.test(name)||name.split('/').includes('..'))throw Error('unexpected-module');
seen.add(name);if(seen.size>4096)throw Error('graph-too-large');
const file=secure(name),source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
function add(spec){if(spec.startsWith('node:'))return;if(spec==='zod'){pending.push('node_modules/zod/index.js');return;}if(!spec.startsWith('.'))throw Error('unexpected-dependency');
const resolved=path.posix.normalize(path.posix.join(path.posix.dirname(name),spec));if(!resolved.endsWith('.js')||resolved.startsWith('../')||(name.startsWith('node_modules/')&&!resolved.startsWith('node_modules/zod/')))throw Error('module-escape');pending.push(resolved);}
function visit(node){if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier){if(!ts.isStringLiteral(node.moduleSpecifier))throw Error('nonliteral-import');add(node.moduleSpecifier.text);}
if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==='require')))throw Error('dynamic-loader');ts.forEachChild(node,visit);}visit(source);}
console.log(JSON.stringify([...seen].sort()));
'''


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_source(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or path.resolve() != path or info.st_size > 8 * 1024 * 1024:
        raise ValueError('unsafe-build-file')
    return path.read_bytes()


def collect_files(build):
    result = subprocess.run(['node', '-e', GRAPH, str(build), str(REPO)], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=True)
    if len(result.stdout) > 512 * 1024:
        raise ValueError('graph-too-large')
    names = json.loads(result.stdout.decode('utf-8'))
    if type(names) is not list or len(names) > MAX_FILES:
        raise ValueError('invalid-graph')
    files = {'package.json': b'{"type":"module","private":true}\n',
             'run-once': read_source(REPO / 'ops/account-funds/run-once'),
             'run-enroll': read_source(REPO / 'ops/account-funds/run-enroll')}
    for name in names + ['node_modules/zod/package.json', 'node_modules/zod/LICENSE']:
        files[name] = read_source(build / name[5:] if name.startswith('dist/') else REPO / name)
    if len(files) > MAX_FILES or sum(len(value) for value in files.values()) > MAX_TOTAL:
        raise ValueError('release-too-large')
    return files


def package(files):
    manifest = json.dumps({name: sha(raw) for name, raw in sorted(files.items())}, sort_keys=True, separators=(',', ':')).encode('ascii')
    release = sha(manifest)
    files = dict(files, **{'manifest.json': manifest})
    raw = io.BytesIO()
    with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for name, content in sorted(files.items()):
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime = len(content), 0o700 if name in ('run-once', 'run-enroll') else 0o600, 0
                archive.addfile(info, io.BytesIO(content))
    return release, raw.getvalue(), len(files)


def write_artifact(destination, raw):
    descriptor = os.open(str(destination), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())


def build_files():
    with tempfile.TemporaryDirectory(prefix='crypto-funds-build-') as temporary:
        build = Path(temporary)
        subprocess.run(['node', str(REPO / 'node_modules/typescript/bin/tsc'), '--target', 'ES2022',
                        '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--esModuleInterop',
                        '--skipLibCheck', '--types', 'node', '--outDir', str(build), '--rootDir', str(REPO / 'src'),
                        str(REPO / 'src/scripts/account-funds.ts'), str(REPO / 'src/scripts/account-funds-enroll.ts')], cwd=str(REPO), stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=True)
        return collect_files(build)


def main():
    if len(sys.argv) != 1:
        raise ValueError('unexpected-arguments')
    release, archive, count = package(build_files())
    destination = OUT if OUT is not None else Path('/tmp/crypto-account-funds-' + release + '.tar.gz')
    if destination.exists():
        if read_source(destination) != archive:
            raise ValueError('existing-artifact-mismatch')
    else:
        write_artifact(destination, archive)
    pin_path = REPO / 'ops/account-funds/release-pin.json'
    temporary_pin = pin_path.with_name('.release-pin.json.tmp')
    pin = {'schema': 1, 'release': release, 'manifestSha256': release}
    write_artifact(temporary_pin, (json.dumps(pin, separators=(',', ':')) + '\n').encode('ascii'))
    temporary_pin.replace(pin_path)
    parent = os.open(str(pin_path.parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    print(json.dumps({'schema': 1, 'release': release, 'files': count, 'artifact': str(destination),
                      'bytes': len(archive), 'credentialsIncluded': False, 'identityObservationIncluded': False}))


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except Exception:
        print('{"schema":1,"error":"funds-build-failed"}')
        sys.exit(1)
