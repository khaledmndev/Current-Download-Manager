"""Build Rust binaries with developer and workspace paths removed from diagnostics."""
from pathlib import Path
import argparse
import os
import subprocess

ROOT = Path(__file__).resolve().parent.parent

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--development-pro', action='store_true')
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    env = dict(os.environ)
    flags = [env['CARGO_ENCODED_RUSTFLAGS']] if env.get('CARGO_ENCODED_RUSTFLAGS') else []
    # Unit-separator encoding preserves Windows paths containing spaces.
    for prefix in [str(Path.home()), str(ROOT)]:
        for spelling in dict.fromkeys([prefix, prefix.replace('\\', '/')]):
            flags.append('--remap-path-prefix=' + spelling + '=.')
    env['CARGO_ENCODED_RUSTFLAGS'] = '\x1f'.join(flags)
    features = 'current-desktop/custom-protocol'
    if args.development_pro:
        features += ',current-daemon/development-pro'
    command = ['cargo', 'build', '--locked', '--target', 'x86_64-pc-windows-msvc',
               '-p', 'current-daemon', '-p', 'current-desktop', '--features', features]
    if not args.debug:
        command.append('--release')
    if args.offline:
        command.append('--offline')
    subprocess.run(command, cwd=ROOT, env=env, check=True)
