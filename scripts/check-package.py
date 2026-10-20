"""Reject private artifacts, media runtimes and embedded local paths in a public package."""
from pathlib import Path
import argparse
import hashlib
import json
import re

FORBIDDEN = {'yt-dlp.exe', 'deno.exe', 'ffmpeg.exe', 'ffprobe.exe',
             'current-browser.json', 'app.current.downloadmanager.json'}
PRIVATE_PATH = re.compile(rb'[A-Za-z]:[/\\]Users[/\\][^\x00\r\n<>" ]+', re.I)

def check(folder):
    folder = folder.resolve()
    inventory = json.loads((folder / 'THIRD_PARTY_LICENSES/inventory.json').read_text(encoding='utf-8-sig'))
    if inventory['missing_notices']:
        raise RuntimeError('The package has unresolved dependency notices.')
    for path in folder.rglob('*'):
        if not path.is_file():
            continue
        rel = path.relative_to(folder)
        if path.name in FORBIDDEN or any(p in {'verification', 'inspection', '.test-data', '.git', 'node_modules'} for p in rel.parts):
            raise RuntimeError('Forbidden public-package artifact: ' + rel.as_posix())
        data = path.read_bytes()
        if PRIVATE_PATH.search(data) or PRIVATE_PATH.search(data.replace(b'\x00', b'')):
            raise RuntimeError('Embedded personal Windows path: ' + rel.as_posix())
    hashed = set()
    for line in (folder / 'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines():
        digest, name = line.split('  ', 1)
        if name in hashed:
            raise RuntimeError('Duplicate package checksum entry.')
        hashed.add(name)
        path = (folder / name).resolve()
        if not path.is_relative_to(folder) or hashlib.sha256(path.read_bytes()).hexdigest() != digest.lower():
            raise RuntimeError('Package checksum mismatch.')
    actual = {p.relative_to(folder).as_posix() for p in folder.rglob('*') if p.is_file() and p.name != 'SHA256SUMS.txt'}
    if hashed != actual:
        raise RuntimeError('Package checksum coverage is incomplete.')
    print('PASS: public package contents, personal-path scan and checksums.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    check(parser.parse_args().folder)
