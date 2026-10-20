"""Create a fresh, allowlisted local Git repository. Never publish or push."""
from pathlib import Path
import argparse
import importlib.util
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('public_check', ROOT / 'scripts/check-public.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / '.publish/current')
    destination = parser.parse_args().output.resolve()
    if destination.exists():
        raise SystemExit('Destination already exists; select a new empty output path to preserve its Git state.')
    files = checker.check()
    destination.mkdir(parents=True)
    for path in files:
        target = destination / path.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    subprocess.run(['git', 'init', '-b', 'main', str(destination)], check=True)
    subprocess.run(['git', '-C', str(destination), 'config', 'core.autocrlf', 'false'], check=True)
    subprocess.run(['git', '-C', str(destination), 'add', '--all'], check=True)
    checker.check(destination)
    print(f'Prepared public source: {destination}')
    print('Files staged for review. No commit, remote, GitHub repository, or push was created.')
