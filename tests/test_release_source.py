import json
import unittest
from unittest.mock import patch
from urllib.error import URLError
import test_network_deploy as fixtures

m = fixtures.m
REPO = 'ghcr.io/example/mirasim'
LATEST = 'https://github.com/example/mirasim/releases/latest/download/deploy.json'
PINNED = 'https://github.com/example/mirasim/releases/download/v0.8.4/deploy.json'
MANIFEST = {'version': '0.8.4', 'image': REPO + '@sha256:' + 'a' * 64}
RELEASE = {'tag_name': 'v0.8.4', 'draft': False, 'prerelease': False,
           'assets': [{'name': 'deploy.json', 'browser_download_url': PINNED}]}


class ReleaseSourceTests(unittest.TestCase):
    def test_latest_resolves_to_immutable_version_in_the_same_repository(self):
        with patch.object(m, 'fetch_json', side_effect=[RELEASE, MANIFEST]) as fetch:
            result = m.fetch_manifest(LATEST, REPO)
        self.assertEqual(result['version'], '0.8.4')
        self.assertEqual(result['_resolution'], 'github_api')
        self.assertEqual(fetch.call_args_list[0].args[0], 'https://api.github.com/repos/example/mirasim/releases/latest')
        self.assertEqual(fetch.call_args_list[1].args[0], PINNED)
        self.assertTrue(all(call.kwargs['refresh'] for call in fetch.call_args_list))

    def test_pinned_source_is_reported_and_not_silently_changed(self):
        self.assertEqual(m.release_source(PINNED)['pinned_version'], '0.8.4')
        with patch.object(m, 'fetch_json', return_value=MANIFEST) as fetch:
            self.assertEqual(m.fetch_manifest(PINNED, REPO)['version'], '0.8.4')
        self.assertEqual(fetch.call_count, 1)
        self.assertEqual(fetch.call_args.args[0], PINNED)

    def test_api_outage_has_explicit_download_fallback(self):
        with patch.object(m, 'fetch_json', side_effect=[URLError('offline'), MANIFEST]) as fetch:
            self.assertEqual(m.fetch_manifest(LATEST, REPO)['_resolution'], 'github_download_fallback')
        self.assertEqual(fetch.call_args_list[1].args[0], LATEST)

    def test_tag_manifest_mismatch_and_foreign_asset_are_rejected(self):
        with patch.object(m, 'fetch_json', side_effect=[RELEASE, {**MANIFEST, 'version': '0.8.2'}]):
            with self.assertRaisesRegex(ValueError, 'version differ'):
                m.fetch_manifest(LATEST, REPO)
        for release in [None, {**RELEASE, 'draft': True}, {**RELEASE, 'prerelease': True},
                        {**RELEASE, 'assets': [{'name': 'deploy.json', 'browser_download_url': 'https://evil.test/deploy.json'}]}]:
            with patch.object(m, 'fetch_json', return_value=release) as fetch:
                with self.assertRaises(ValueError):
                    m.fetch_manifest(LATEST, REPO)
                self.assertEqual(fetch.call_count, 1)

    def test_source_repair_is_limited_to_same_github_ghcr_repository(self):
        self.assertEqual(m.follow_latest_url(PINNED, REPO), LATEST)
        self.assertEqual(m.follow_latest_url(LATEST, REPO), LATEST)
        for url, repo in [('https://example.test/feed?key=private-value', REPO), (PINNED, 'ghcr.io/other/repo')]:
            with self.assertRaises(ValueError):
                m.follow_latest_url(url, repo)
        self.assertEqual(m.release_source('https://example.test/feed?key=private-value'), {'kind': 'custom'})

    def test_requests_revalidate_cache_and_leave_custom_queries_unchanged(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def read(self, _): return b'{}'
        seen = []
        class Opener:
            def open(self, req, **kw):
                seen.append(req); return Response()
        with patch.object(m, 'build_opener', return_value=Opener()):
            m.fetch_json(LATEST, refresh=True)
            custom = 'https://example.test/deploy?signature=keep'
            m.fetch_json(custom)
        self.assertIn('mirasim_check=', seen[0].full_url)
        self.assertEqual(seen[1].full_url, custom)
        self.assertIn('no-cache', seen[0].get_header('Cache-control'))
