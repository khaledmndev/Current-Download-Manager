"""Check the explicit publish set; fail on high-confidence secrets/private paths."""
from pathlib import Path
import re
import subprocess
import sys
from public_files import public_files

ROOT = Path(__file__).resolve().parent.parent
PATTERNS = [
    re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'),
    re.compile(r'\bAKIA[0-9A-Z]{16}\b'),
    re.compile(r'C:[/\\]+Users[/\\]+(?!Public(?:[/\\]|$))[^\s"<>]+', re.I),
]

def check(root=ROOT):
    failures = []
    files = public_files(root)
    if not files:
        raise RuntimeError('The public source set is empty.')
    for path in files:
        if path.suffix.lower() in {'.png', '.ico', '.icns', '.rgba'}:
            continue
        try:
            text = path.read_text(encoding='utf-8-sig')
        except UnicodeDecodeError:
            failures.append(str(path.relative_to(root)) + ': unreviewed binary')
            continue
        if any(pattern.search(text) for pattern in PATTERNS):
            failures.append(str(path.relative_to(root)) + ': potential secret or personal path')
    # If this is an initialized repository, prevent ignored material already
    # present in the index from escaping the source allowlist.
    if (root / '.git').is_dir():
        indexed = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'], capture_output=True, check=True).stdout
        allowed = {p.relative_to(root).as_posix() for p in files}
        for name in indexed.decode().split('\0'):
            if name and name not in allowed:
                failures.append(name + ': indexed file is outside the public allowlist')
    if failures:
        print('\n'.join(failures), file=sys.stderr)
        raise RuntimeError('Public source review failed; matching values were not printed.')
    print(f'PASS: {len(files)} allowlisted files; no matched secret/private-path patterns.')
    print('This targeted scan is not a comprehensive security audit.')
    return files

if __name__ == '__main__':
    check()
