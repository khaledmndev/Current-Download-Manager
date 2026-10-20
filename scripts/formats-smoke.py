"""Read-only, real per-video quality discovery through Current's native protocol."""
from pathlib import Path
import argparse, json, os, struct, subprocess, uuid
from concurrent.futures import ThreadPoolExecutor

parser = argparse.ArgumentParser()
parser.add_argument('--bin-dir', default='target/x86_64-pc-windows-msvc/release')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
bins = (root / args.bin_dir).resolve()
state = root / '.test-data' / ('formats-' + uuid.uuid4().hex[:8])
state.mkdir(parents=True)
origin = 'chrome-extension://' + (root / 'extensions/chromium/EXTENSION_ID.txt').read_text().strip() + '/'
env = dict(os.environ, CURRENT_DATA_DIR=str(state / 'state'), CURRENT_EXTENSION_ORIGIN=origin)

def call(operation, payload=None):
    data = json.dumps({'operation': operation, 'payload': payload}).encode()
    result = subprocess.run([str(bins / 'current-native-host.exe'), origin],
        input=struct.pack('<I', len(data)) + data, capture_output=True, env=env,
        timeout=90, creationflags=0x08000000)
    assert result.returncode == 0, result.stderr.decode()
    reply = json.loads(result.stdout[4:])
    assert reply['ok'], reply
    return reply.get('data')

def check(video):
    formats = call('youtube_formats', {'url': 'https://www.youtube.com/watch?v=' + video})
    assert formats['heights'] == sorted(set(formats['heights']), reverse=True)
    assert all(32 <= h <= 8640 for h in formats['heights'])
    assert formats['audio_available']
    assert 'url' not in formats
    return {'video': video, **formats}

report = {}
try:
    assert call('status')['count'] == 0
    with ThreadPoolExecutor(max_workers=2) as pool:
        report['videos'] = list(pool.map(check, ['jNQXAC9IVRw', 'aqz-KE-bpKQ']))
    assert report['videos'][0]['heights'] != report['videos'][1]['heights']
    assert call('status')['count'] == 0
    report['no_downloads_enqueued'] = True
    print(json.dumps(report, indent=2), flush=True)
finally:
    subprocess.run([str(bins / 'current-cli.exe'), 'shutdown'], env=env, capture_output=True, timeout=20, creationflags=0x08000000)
    (state / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print('Report:', state / 'report.json')
