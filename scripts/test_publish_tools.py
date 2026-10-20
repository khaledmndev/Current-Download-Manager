"""Offline tests for media-install verification and public-file selection."""
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch
import hashlib
import importlib.util
import io
import json
import tempfile
import zipfile
from public_files import public_files

spec = importlib.util.spec_from_file_location('install_media', Path(__file__).with_name('install-media.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

package_spec = importlib.util.spec_from_file_location('check_package', Path(__file__).with_name('check-package.py'))
package_checker = importlib.util.module_from_spec(package_spec)
package_spec.loader.exec_module(package_checker)

class PublishToolsTests(TestCase):
    def fixture(self, root, bad_digest=False):
        content = io.BytesIO()
        with zipfile.ZipFile(content, 'w') as archive:
            archive.writestr('deno.exe', b'deno-test-fixture')
        bodies = {'https://github.com/fixture/yt.exe': b'yt-test-fixture',
                  'https://github.com/fixture/deno.zip': content.getvalue(),
                  'https://raw.githubusercontent.com/fixture/LICENSE': b'license-test-fixture'}
        pins = []
        for project, filename, url in [('yt-dlp', 'yt-dlp.exe', 'https://github.com/fixture/yt.exe'),
                                       ('deno', 'deno.zip', 'https://github.com/fixture/deno.zip')]:
            pins.append({'project': project, 'file': filename, 'url': url,
                         'sha256': '0' * 64 if bad_digest else hashlib.sha256(bodies[url]).hexdigest(),
                         'licenses': [{'file': project + '-LICENSE.txt', 'url': 'https://raw.githubusercontent.com/fixture/LICENSE'}]})
        (root / 'scripts').mkdir()
        (root / 'scripts/media-runtime.json').write_text(json.dumps(pins), encoding='utf-8')
        return bodies

    def test_checksum_failure_preserves_existing_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bodies = self.fixture(root, bad_digest=True)
            destination = root / 'media'
            destination.mkdir()
            (destination / 'yt-dlp.exe').write_bytes(b'existing')
            with patch.object(installer, 'ROOT', root), patch.object(installer, 'download', side_effect=bodies.__getitem__):
                with self.assertRaises(ValueError):
                    installer.install(destination)
            self.assertEqual((destination / 'yt-dlp.exe').read_bytes(), b'existing')
            self.assertFalse((destination / 'deno.exe').exists())

    def test_verified_install_includes_notices_without_executing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bodies = self.fixture(root)
            with patch.object(installer, 'ROOT', root), patch.object(installer, 'download', side_effect=bodies.__getitem__):
                installer.install(root / 'media')
            self.assertEqual((root / 'media/deno.exe').read_bytes(), b'deno-test-fixture')
            self.assertTrue((root / 'media/DEPENDENCIES.json').is_file())
            self.assertEqual(len(list((root / 'media').glob('*LICENSE.txt'))), 2)

    def test_public_selection_excludes_research_captures_and_media(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ['README.md', 'crates/core/src/lib.rs', 'crates/core/clip.m4s',
                         'inspection/background.js', 'verification/personal.png',
                         'apps/desktop/dist/assets/private.js', 'scripts/install-media.py']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture', encoding='utf-8')
            selected = {path.relative_to(root).as_posix() for path in public_files(root)}
            self.assertEqual(selected, {'README.md', 'crates/core/src/lib.rs', 'scripts/install-media.py'})

    def package_fixture(self, root):
        notices = root / 'THIRD_PARTY_LICENSES'
        notices.mkdir()
        (notices / 'inventory.json').write_text(json.dumps({'missing_notices': []}), encoding='utf-8')
        (root / 'Current.exe').write_bytes(b'fake-binary-for-checker-test')
        entries = []
        for path in root.rglob('*'):
            if path.is_file():
                entries.append(hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.relative_to(root).as_posix())
        (root / 'SHA256SUMS.txt').write_text('\n'.join(entries) + '\n', encoding='utf-8')

    def test_package_rejects_unhashed_extra_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.package_fixture(root)
            package_checker.check(root)
            (root / 'unhashed.txt').write_text('extra', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'coverage'):
                package_checker.check(root)

    def test_package_rejects_embedded_personal_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.package_fixture(root)
            private_path = 'C:' + chr(92) + 'Users' + chr(92) + 'FixtureUser' + chr(92) + 'source.rs'
            (root / 'Current.exe').write_bytes(private_path.encode('utf-16-le'))
            with self.assertRaisesRegex(RuntimeError, 'personal Windows path'):
                package_checker.check(root)

if __name__ == '__main__':
    main()
