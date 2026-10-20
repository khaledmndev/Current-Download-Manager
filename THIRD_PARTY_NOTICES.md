# Third-party components

Current's original code is proprietary; third-party components retain their own
licenses. Building a public portable package generates `THIRD_PARTY_LICENSES/`
with the Rust/npm dependency inventory and available license/notice files.
This generated directory must accompany distributed Current binaries. Unmodified
registry source archives for MPL-licensed Rust dependencies are included there. The
packager fails if those notices have not been generated.

## External media tools (not shipped in public packages)

- yt-dlp: https://github.com/yt-dlp/yt-dlp — source is Unlicense; its standalone
  PyInstaller executable contains GPLv3+ components. See the upstream LICENSE,
  THIRD_PARTY_LICENSES.txt and licensing section. Do not assume the executable
  has the same license as the source-only distribution.
- Deno: https://github.com/denoland/deno — MIT and bundled third-party notices.
- FFmpeg/FFprobe: https://ffmpeg.org/legal.html — licensing depends on the build.
  These executables are not redistributed or downloaded by Current's installer.

`scripts/install-media.py` downloads pinned, checksum-verified official yt-dlp
and Deno assets for the user's local installation, together with required
upstream notices. Pins and source references are in `scripts/media-runtime.json`.
It does not copy those tools into a public release package. Anyone changing the
redistribution boundary must review and satisfy the corresponding licenses and
source-distribution obligations first.

## Identity and prior research

The Current logo is original project artwork. The UI uses local system fonts.
The public repository contains Current's original extension and engine; it
excludes copied IDM extension files, installation artifacts and raw research.
No affiliation with Internet Download Manager or Tonec is implied.
