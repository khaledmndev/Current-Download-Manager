# Alpha status

Current is a development application, not a complete IDM replacement.

Local verification before public preparation: 27 extension tests, 17 Rust core
unit/transfer tests, two additional installed-runtime/process tests, TypeScript
and Vite production build, and real Windows native-protocol checks passed.
Live checks exercised two videos with different available resolutions, MP4/M4A/
MP3 outputs, FFprobe codec checks and SHA-256 verification. An installed Edge
submission completed successfully. New-format-menu UI was exercised in a
labeled local fixture; broader installed Chrome/Edge behavior needs more QA.
GitHub-hosted CI has not run yet.

The binaries are unsigned. Windows installer, code signing, automatic updates,
production billing/accounts, subscription activation, Teams administration,
recurring schedules, authenticated browser replay, Firefox, arbitrary-site
adaptive extraction and complete localization remain unfinished.

YouTube requires Development Pro and separately installed external tools.
It supports public single videos, not DRM, live streams, playlists or private/
age-restricted material. Resolution choices reflect detected source formats,
not upscaling. Download only material you have permission to save.

Persistent jobs contain submitted source URLs. Exports and diagnostics should
be reviewed for private links before sharing. Browser handoff is opt-in and its
session tracking resets when the extension is reloaded or disabled.
