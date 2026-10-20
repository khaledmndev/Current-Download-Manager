# Supplemental upstream license texts

Some published Rust crates omit license files. These exact upstream notices are
pinned by URL and SHA-256 in scripts/license-sources.json. The commit revisions
come from each crate's .cargo_vcs_info.json. selectors uses Mozilla's canonical
MPL 2.0 text because its pinned repository has only file-level license notices.
The notice generator also includes unmodified registry source archives for all
MPL-licensed Rust dependencies, with their source URLs in its inventory.

Native npm tooling packages without notices inherit the license files of their
same-version parent package (esbuild, Rollup or Tauri CLI); the generator checks
that the versions match. Generated notices include development dependencies as
well as runtime dependencies so the inventory is conservative.
