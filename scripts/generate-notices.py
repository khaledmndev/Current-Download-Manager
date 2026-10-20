"""Collect dependency license files for the locally built portable application."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent

def notices(directory):
    return [p for p in directory.iterdir() if p.is_file() and
            any(word in p.name.lower() for word in ('license', 'licence', 'copying', 'copyright', 'notice'))]

def generate(output, offline=False):
    command = ['cargo', 'metadata', '--locked', '--format-version', '1',
               '--filter-platform', 'x86_64-pc-windows-msvc',
               '--features', 'current-daemon/development-pro,current-desktop/custom-protocol']
    if offline:
        command.append('--offline')
    metadata = json.loads(subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True).stdout)
    pins = json.loads((ROOT / 'scripts/license-sources.json').read_text(encoding='utf-8-sig'))
    dependencies = []
    mpl_sources = []
    for package in metadata['packages']:
        if package['id'] in metadata['workspace_members']:
            continue
        directory = Path(package['manifest_path']).parent
        files = notices(directory)
        if package.get('license_file'):
            extra = directory / package['license_file']
            if extra.is_file():
                files.append(extra)
        if not files:
            for pin in pins.get('rust:' + package['name'] + '@' + package['version'], []):
                source = ROOT / pin['path']
                if hashlib.sha256(source.read_bytes()).hexdigest() != pin['sha256']:
                    raise RuntimeError('Pinned license text checksum mismatch.')
                files.append(source)
        if 'MPL-' in (package.get('license') or ''):
            archive = directory.parents[2] / 'cache' / directory.parent.name / (package['name'] + '-' + package['version'] + '.crate')
            if not archive.is_file():
                raise RuntimeError('Missing MPL source archive: ' + package['name'])
            mpl_sources.append(archive)
        dependencies.append(('rust', package['name'], package['version'], package.get('license'), sorted(set(files))))
    lock = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8-sig'))
    for location, package in lock['packages'].items():
        if not location:
            continue
        directory = ROOT / location
        if not (directory / 'package.json').is_file():
            if package.get('optional'):
                continue
            raise RuntimeError('Run npm ci before generating dependency notices.')
        manifest = json.loads((directory / 'package.json').read_text(encoding='utf-8-sig'))
        files = notices(directory)
        parent_name = ('esbuild' if manifest['name'].startswith('@esbuild/') else 'rollup' if manifest['name'].startswith('@rollup/') else '@tauri-apps/cli' if manifest['name'].startswith('@tauri-apps/cli-') else None)
        if not files and parent_name:
            parent = ROOT / 'node_modules' / parent_name
            parent_manifest = json.loads((parent / 'package.json').read_text(encoding='utf-8-sig'))
            if parent_manifest['version'] != manifest['version']:
                raise RuntimeError('Native npm binary/parent license version mismatch.')
            files = notices(parent)
        dependencies.append(('npm', manifest['name'], manifest['version'], manifest.get('license'), files))
    output.mkdir(parents=True, exist_ok=True)
    for source in mpl_sources:
        target = output / 'sources' / source.name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    inventory, missing = [], []
    for ecosystem, name, version, license_id, files in dependencies:
        key = re.sub(r'[^a-zA-Z0-9._-]', '-', f'{ecosystem}-{name}-{version}')
        entry = {'ecosystem': ecosystem, 'name': name, 'version': version, 'license': license_id, 'notices': [], 'source_url': f'https://crates.io/api/v1/crates/{name}/{version}/download' if ecosystem == 'rust' else f'https://www.npmjs.com/package/{name}/v/{version}'}
        if not files:
            missing.append(f'{ecosystem}:{name}@{version}')
        for index, source in enumerate(files):
            filename = f'{key}/{index:02d}-{source.name}'
            target = output / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            entry['notices'].append(filename)
        inventory.append(entry)
    (output / 'inventory.json').write_text(json.dumps({'dependencies': inventory, 'missing_notices': missing, 'mpl_source_archives': [f'sources/{p.name}' for p in mpl_sources]}, indent=2) + '\n', encoding='utf-8')
    if missing:
        raise RuntimeError('Review missing license/notice files before distributing binaries: ' + ', '.join(missing))
    print(f'Collected notices for {len(inventory)} dependency packages.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'THIRD_PARTY_LICENSES')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    generate(args.output, args.offline)
