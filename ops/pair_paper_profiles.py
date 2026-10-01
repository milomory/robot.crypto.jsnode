"""Fixed public capture limits shared by the isolated launcher and verifier."""

import hashlib
import json
import re
import stat

MIB = 1024 * 1024
PROFILES = {
    'probe': {'samples': 60, 'command': 'collect', 'watchdog': '350s',
              'maxDurationMs': 330_000, 'maxFileBytes': 128 * 1024,
              'maxArchiveBytes': 48 * MIB, 'maxTransferBytes': 48 * MIB,
              'transferTimeout': 120, 'minimumFreeBytes': 64 * MIB},
    'study-30m': {'samples': 360, 'command': 'collect-study', 'watchdog': '1850s',
                  'maxDurationMs': 1_830_000, 'maxFileBytes': 128 * 1024,
                  'maxArchiveBytes': 48 * MIB, 'maxTransferBytes': 48 * MIB,
                  'transferTimeout': 120, 'minimumFreeBytes': 64 * MIB},
    'study-24h': {'samples': 1440, 'command': 'collect-day', 'watchdog': '86450s',
                  'maxDurationMs': 86_430_000, 'maxFileBytes': 32 * 1024,
                  'maxArchiveBytes': 48 * MIB, 'maxTransferBytes': 50 * MIB,
                  'transferTimeout': 300, 'minimumFreeBytes': 256 * MIB},
}


def profile_limits(name):
    if name not in PROFILES:
        raise RuntimeError('invalid-profile')
    return dict(PROFILES[name])


def launch_arguments(args):
    profile = 'probe'
    if args[:1] in [['--study-30m'], ['--study-24h']]:
        profile, args = args[0][2:], args[1:]
    if len(args) != 2 or args[0].startswith('--'):
        raise RuntimeError('expected bundle and new evidence directory')
    return profile, args


def inspect_archive(archive, limits, running=False):
    """Return only filenames/hashes and safe progress, never market or fee values."""
    if archive.is_symlink() or (archive.exists() and not archive.is_dir()):
        raise RuntimeError('invalid-archive-directory')
    sample_names = {f'{i:03d}.json' for i in range(limits['samples'])}
    expected = sample_names | {'manifest.json', 'instruments.json', 'state.json'}
    if not archive.exists():
        if running:
            return {'sampledCount': 0, 'archiveBytes': 0, 'startedAt': None, 'deadlineAt': None}
        raise RuntimeError('missing-archive')
    if archive.lstat().st_mode & 0o777 != 0o700:
        raise RuntimeError('invalid-archive-permissions')
    paths = list(archive.iterdir())
    names = {p.name for p in paths}
    temporary = set()
    if running:
        for name in names - expected:
            target, separator, suffix = name.partition('.tmp-')
            if separator and target in expected and re.fullmatch(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', suffix):
                temporary.add(name)
    if len(temporary) > 1 or not names <= expected | temporary or (not running and names != expected):
        raise RuntimeError('invalid-archive-file-set')
    total, sampled, hashes = 0, 0, {}
    for path in paths:
        try:
            info = path.lstat()
        except FileNotFoundError:
            if running and path.name in temporary:
                continue  # The collector just completed its atomic write.
            raise
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o777 != 0o600 or info.st_size > limits['maxFileBytes']:
            raise RuntimeError('invalid-archive-file')
        total += info.st_size
        if total > limits['maxArchiveBytes']:
            raise RuntimeError('archive-too-large')
        if path.name in sample_names and info.st_size > 0:
            sampled += 1
        if not running:
            data = path.read_bytes()
            if len(data) != info.st_size or not data:
                raise RuntimeError('archive-file-changed')
            hashes[path.name] = hashlib.sha256(data).hexdigest()
    started, deadline = None, None
    if 'manifest.json' in names:
        raw = (archive / 'manifest.json').read_bytes()
        if not 0 < len(raw) <= limits['maxFileBytes']:
            raise RuntimeError('invalid-manifest-size')
        manifest = json.loads(raw)
        started = manifest.get('startedAt')
        if isinstance(started, bool) or not isinstance(started, int) or started <= 0:
            raise RuntimeError('invalid-manifest-time')
        if manifest.get('plan', {}).get('maxDurationMs') != limits['maxDurationMs']:
            raise RuntimeError('invalid-manifest-deadline')
        deadline = started + limits['maxDurationMs']
    result = {'sampledCount': sampled, 'archiveBytes': total, 'startedAt': started, 'deadlineAt': deadline}
    if not running:
        result['files'] = hashes
    return result
