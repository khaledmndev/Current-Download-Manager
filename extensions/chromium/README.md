# Current browser extension 0.4.0

Original Manifest V3 extension for Chrome and Edge (Chromium 127+). This is an
unpacked alpha, not a Chrome Web Store listing.

## Install

Load this folder with Developer mode at chrome://extensions or edge://extensions.
Run scripts/register-browser.ps1 from the companion desktop package, then reload
the extension and refresh the webpage. The stable development ID is
kldaaejfimcdbooimpmjhonkghbijjlg. Registration modifies Current's own per-user
native-host entries and permits this extension to start the local engine and
open Current. No registration is applied by building or loading source alone.

## Features

Download with Current sends supported links to the desktop engine. Scanning
collects page/selected links and direct media; the popup provides filtering,
batch selection, recent jobs, pause/resume and site exclusions. Explicit sends
open the desktop app. The YouTube button checks the current video's formats
and lists actual resolutions, plus MP3 and M4A when audio is available. It does
not start a download until a format is selected. The × dismisses the panel for
the current video; a page refresh restores it.

YouTube requires the Development Pro build and separately installed yt-dlp,
Deno, FFmpeg and FFprobe. Public packages do not ship those executables. See the
main README for checksum-pinned local installation. DRM, live streams, playlists,
login-required media and arbitrary-site adaptive extraction are unsupported.

## Permissions and privacy

Required permissions: activeTab, scripting, contextMenus, nativeMessaging,
storage, alarms and webRequest. YouTube hosts have scoped persistent access for
player integration. Other site access and Downloads permission are optional.
No cookie/password access, browser-history API, analytics or remote backend is
used. Preferences use local extension storage; discovery and handoff state use
session storage. Submitted URL metadata persists in the local desktop library.
Video-format metadata returns a title and resolutions, not raw signed media URLs.

## Optional browser handoff

Off by default. When enabled, safe non-private matching browser downloads can be
paused and transferred to Current. Chrome's original is cancelled only after
Current completes with matching length and a SHA-256 value. Failure restores the
original; an originally paused item remains paused. Completed browser files and
history are never deleted. Reloading/disabling the extension or closing the
browser clears session tracking; manually resume remaining paused originals in
the browser Downloads page. The independent engine may continue after closure.

Current performs a separate public GET. Cookies, Authorization and POST bodies
are not replayed. Keep session-bound downloads in the browser. A computed digest
and matching length do not prove equivalence to an authenticated browser response.

## Validation boundary

27 policy/worker checks and real Windows native-protocol tests passed locally.
Per-video format discovery and MP4/M4A/MP3 outputs passed real public-video checks.
An installed Edge submission completed with file hash verification. The updated
format menu was exercised in a labeled local adapter with real native engine;
Chrome APIs there were simulated. Broader installed browser/permissions/handoff
QA is still needed. Personal QA captures and reports are not published.
