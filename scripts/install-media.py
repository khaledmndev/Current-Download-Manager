"""Install pinned official external media tools locally; never run them or edit PATH."""
from pathlib import Path
import argparse
import hashlib
import io
import json
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent

def download(url):
    if not url.startswith(('https://github.com/', 'https://raw.githubusercontent.com/')):
        raise ValueError('Only pinned official GitHub download locations are accepted.')
    request = urllib.request.Request(url, headers={'User-Agent': 'Current-media-setup/0.4'})
    with urllib.request.urlopen(request, timeout=120) as response:
        data = response.read(256 * 1024 * 1024 + 1)
    if len(data) > 256 * 1024 * 1024:
        raise ValueError('Download exceeds its size limit.')
    return data

def install(destination):
    pins = json.loads((ROOT / 'scripts/media-runtime.json').read_text(encoding='utf-8-sig'))
    destination = destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    # Fetch and verify everything before replacing installed files.
    payloads = {}
    for pin in pins:
        body = download(pin['url'])
        if hashlib.sha256(body).hexdigest() != pin['sha256']:
            raise ValueError(f"Checksum mismatch: {pin['project']}; nothing was installed.")
        if pin['file'].endswith('.zip'):
            with zipfile.ZipFile(io.BytesIO(body)) as archive:
                info = archive.getinfo('deno.exe')
                if info.file_size > 256 * 1024 * 1024:
                    raise ValueError('Extracted executable exceeds its size limit.')
                payloads['deno.exe'] = archive.read(info)
        else:
            payloads['yt-dlp.exe'] = body
        for notice in pin['licenses']:
            payloads[notice['file']] = download(notice['url'])
    payloads['DEPENDENCIES.json'] = (json.dumps(pins, indent=2) + '\n').encode()
    with tempfile.TemporaryDirectory(prefix='current-media-') as staging:
        staged = Path(staging)
        for name, body in payloads.items():
            (staged / name).write_bytes(body)
        # Replacement is per-file; a disk error may leave a partial installation.
        for name in payloads:
            target = destination / name
            target.write_bytes((staged / name).read_bytes())
    print(f'Installed verified yt-dlp and Deno with notices into {destination}')
    print('Install FFmpeg and FFprobe separately on PATH, then restart Current.')
    print('No programs were executed; browser registration and PATH were unchanged.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, default=ROOT / ('media' if (ROOT / 'Current.exe').is_file() else 'runtime/media'))
    args = parser.parse_args()
    install(args.destination)
