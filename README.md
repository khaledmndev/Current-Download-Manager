# Current Download Manager

Windows download manager with an original Rust engine, Tauri/React desktop app,
and Manifest V3 extension for Chrome and Edge. **Public alpha; proprietary
source available for inspection.** See [LICENSE](LICENSE) for permissions.

## Implemented

- Parallel HTTP/HTTPS transfers, durable pause/resume, strong-ETag validation.
- SHA-256 verification, safe publication, and preservation of existing files.
- Persistent SQLite library, queues, search, dark mode, and partial Arabic/RTL.
- Browser integration, direct-file discovery, and optional browser handoff.
- Public single-video YouTube downloads: actual per-video quality choices,
  merged MP4, MP3 conversion, and M4A audio. The player panel can be dismissed.

Free builds allow two active downloads and two connections per file.
`DevelopmentPro` is an explicit compile-time development mode enabling media,
batches, named queues and one-time scheduling. It is not a paid license.
**Billing, accounts, subscription activation and Teams administration are not
implemented.** See [status and limitations](docs/STATUS.md).

## Build on Windows

Install Rust stable with MSVC/C++ Build Tools and Windows SDK, Node.js 20.19+
(or a compatible later LTS), Python 3.12+, and WebView2. From the repository:

```powershell
npm ci --no-audit --no-fund
./scripts/build.ps1 -DevelopmentPro
# Omit -DevelopmentPro for Free limits.
```

The script installs locked frontend dependencies, builds the app and engine,
generates dependency license notices and creates an unsigned portable alpha ZIP
under `release/`. No installer, startup service, or browser registration is run.
GitHub Actions repeats the local checks; its first hosted result is pending.

## Run and connect the browser

Extract the portable package and open `Current.exe`. Keep all four Current
executables together. Closing the window hides it to the tray; downloads run in
the separate background engine. Data is stored in
`%LOCALAPPDATA%\CurrentDownloadManager`, with downloads in
`%USERPROFILE%\Downloads\Current` by default.

1. Open `chrome://extensions` or `edge://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select the package's `extensions/chromium` folder.
3. In PowerShell, run the package's `scripts/register-browser.ps1`.
4. Reload the extension, refresh the webpage, and check the connection in its popup.

The development extension ID is `kldaaejfimcdbooimpmjhonkghbijjlg`. Registration
changes only Current's per-user Chrome/Edge native-host entries. It allows this
extension to launch the engine and open Current; it does not modify other apps.
Browser handoff is off by default. See [extension documentation](extensions/chromium/README.md).

## Optional YouTube runtime

Public packages do **not** redistribute yt-dlp, Deno, FFmpeg, or FFprobe.
To download checksum-pinned yt-dlp and Deno from their official projects into
an extracted package:

```powershell
python ./scripts/install-media.py --destination ./media
```

Install FFmpeg and FFprobe separately on PATH from a distribution you trust,
then restart Current. [Dependency details and licenses](THIRD_PARTY_NOTICES.md)
explain the external runtime boundary. The installer never registers browsers,
changes PATH, runs downloaded programs, or downloads videos. YouTube changes may
require updating the pinned runtime and retesting. DRM, live streams, playlists,
login-required media and browser-cookie replay are unsupported.

## Validate

```powershell
npm run test:extension
npm run build
cargo fmt --all -- --check
cargo test --locked -p current-core --target x86_64-pc-windows-msvc
python scripts/check-public.py
python scripts/test_publish_tools.py
```

Optional Windows native and live-media checks are documented in
[release preparation](docs/RELEASING.md). Personal screenshots, download history,
raw inspection material, downloaded media and local test outputs are excluded.
The code uses no IDM source or assets, and Current is not affiliated with IDM.
