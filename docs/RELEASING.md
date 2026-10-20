# Preparing a public alpha

1. Run frontend/core/extension checks documented in README.md.
2. Build with scripts/build.ps1, choosing Free or explicit DevelopmentPro.
3. Ensure scripts/generate-notices.py succeeded. Review its dependency inventory
   and license files; preserve them with distributed binaries.
4. Run scripts/check-public.py and scripts/prepare-public.py. The latter creates
   a separate allowlisted source tree at .publish/current with its own main
   branch. It never pushes, creates GitHub repositories, copies local history,
   or changes the working app. Review its staged file list before a first commit.
5. On GitHub, enable private vulnerability reporting. Run the Windows workflow
   and inspect its first hosted results before promoting the alpha.
6. Use only the new public-alpha package, not earlier development ZIPs. It must
   omit media executables, browser registration/configuration, inspection files,
   test reports, screenshots, personal paths and downloaded media. Its hashes
   cover every distributed file except the checksum file itself.
7. Publishing awaits the maintainer's destination repository URL. Do not invent
   a remote, publish billing claims, or describe the proprietary code as open source.

Optional local checks after building:

```powershell
python scripts/browser-smoke.py --bin-dir target/x86_64-pc-windows-msvc/release
# Only with separately installed media tools available to the test executables:
python scripts/formats-smoke.py
python scripts/youtube-smoke.py
cargo test -p current-core --target x86_64-pc-windows-msvc media::tests -- --ignored
```

Live checks access public YouTube URLs and create isolated local files. They are
not part of default CI because network availability and upstream behavior vary.
Never publish .test-data or personal verification captures.
