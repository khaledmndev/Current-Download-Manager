"""Explicit source allowlist shared by the public exporter and privacy checker."""
from pathlib import Path

FILES = {
    '.gitignore', '.gitattributes', 'Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json',
    'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'CONTRIBUTING.md',
}
TREES = ('apps', 'crates', 'extensions', 'branding', 'docs', '.github', 'scripts')
EXCLUDED_PARTS = {'node_modules', 'target', 'dist', 'gen', '__pycache__', 'binaries'}
EXCLUDED_SCRIPTS = {'feature-status.py'}
SOURCE_SUFFIXES = {'.rs', '.toml', '.lock', '.json', '.ts', '.tsx', '.css', '.html', '.js', '.mjs', '.py', '.ps1', '.md', '.txt', '.svg', '.png', '.ico', '.icns', '.rgba', '.yml', '.yaml'}

def public_files(root: Path):
    paths = [root / name for name in FILES if (root / name).is_file()]
    for tree in TREES:
        directory = root / tree
        if not directory.is_dir():
            continue
        for path in directory.rglob('*'):
            if not path.is_file():
                continue
            rel = path.relative_to(root)
            if any(part in EXCLUDED_PARTS for part in rel.parts):
                continue
            if path.name in {'current-browser.json', 'app.current.downloadmanager.json'}:
                continue
            if path.suffix.lower() in {'.log', '.pyc', '.db', '.sqlite', '.exe', '.dll', '.crx'}:
                continue
            if path.suffix.lower() not in SOURCE_SUFFIXES and path.name not in FILES and not path.name.lower().startswith(('license', 'licence', 'copying', 'notice')):
                continue
            if tree == 'scripts' and path.name in EXCLUDED_SCRIPTS:
                continue
            if path.name == '.env' or path.name.startswith('.env.'):
                continue
            paths.append(path)
    return sorted(set(paths))
