from __future__ import annotations

import json
import unittest
from pathlib import PurePosixPath

from ytb_vps_v2.domain.backup import (
    CheckpointManifest,
    FileDigest,
    ManifestEntry,
    SourceIdentity,
    VerifiedInputArchive,
    canonical_manifest_bytes,
    parse_manifest_bytes,
)
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.models import JobId


SHA_A = "a" * 64
SHA_B = "b" * 64
SHA_C = "c" * 64
V1_BYTES = (
    b'{"artifacts":[{"key":"artifacts/a.json","sha256":"cccccccccccccccc'
    b'cccccccccccccccccccccccccccccccccccccccccccccccc","size_bytes":3},'
    b'{"key":"artifacts/z.json","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    b'bbbbbbbbbbbbbbbbbbbbbbbbbbbb","size_bytes":4}],"checkpoint_id":'
    b'"checkpoint-001","created_at":"2026-07-16T21:20:00+07:00",'
    b'"input_archive":{"key":"inputs/aa/source.mp4","sha256":"aaaaaaaaaaaaaa'
    b'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size_bytes":5},'
    b'"job_id":"job-001","source":{"name":"source.mp4","sha256":"aaaaaaaaaaaa'
    b'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size_bytes":5},'
    b'"state_snapshot":{"key":"state/job-v2.sqlite","sha256":"bbbbbbbbbbbbbb'
    b'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size_bytes":9},'
    b'"version":1}\n'
)
V2_BYTES = (
    b'{"artifacts":[{"key":"artifacts/a.json","sha256":"cccccccccccccccc'
    b'cccccccccccccccccccccccccccccccccccccccccccccccc","size_bytes":3},'
    b'{"key":"artifacts/z.json","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    b'bbbbbbbbbbbbbbbbbbbbbbbbbbbb","size_bytes":4}],"checkpoint_id":'
    b'"checkpoint-001","created_at":"2026-07-16T21:20:00+07:00",'
    b'"input_archive":{"key":"inputs/aa/source.mp4","sha256":"aaaaaaaaaaaaaa'
    b'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size_bytes":5},'
    b'"job_id":"job-001","source":{"name":"source.mp4","sha256":"aaaaaaaaaaaa'
    b'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size_bytes":5},'
    b'"state_snapshot":{"key":"state/job-v2.sqlite","sha256":"bbbbbbbbbbbbbb'
    b'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size_bytes":9},'
    b'"version":2}\n'
)


def entry(key: str, size: int, sha256: str) -> ManifestEntry:
    return ManifestEntry(PurePosixPath(key), FileDigest(size, sha256))


def manifest(version: int = 1) -> CheckpointManifest:
    source = SourceIdentity("source.mp4", FileDigest(5, SHA_A))
    return CheckpointManifest(
        version=version,
        checkpoint_id="checkpoint-001",
        job_id=JobId("job-001"),
        source=source,
        input_archive=entry("inputs/aa/source.mp4", 5, SHA_A),
        state_snapshot=entry("state/job-v2.sqlite", 9, SHA_B),
        artifacts=(
            entry("artifacts/a.json", 3, SHA_C),
            entry("artifacts/z.json", 4, SHA_B),
        ),
        created_at="2026-07-16T21:20:00+07:00",
    )


class BackupValueTests(unittest.TestCase):
    def test_accepts_exact_values_and_archive_evidence(self) -> None:
        source = SourceIdentity("source.mp4", FileDigest(5, SHA_A))
        archive = VerifiedInputArchive(
            source,
            entry("inputs/aa/source.mp4", 5, SHA_A),
            "2026-07-16T21:20:00+07:00",
        )

        self.assertEqual(archive.source, source)
        self.assertEqual(archive.archive.digest, source.digest)

    def test_rejects_invalid_digest_types_and_values(self) -> None:
        for size in (True, -1, 1.5):
            with self.subTest(size=size):
                with self.assertRaises(DomainInvariantError):
                    FileDigest(size, SHA_A)  # type: ignore[arg-type]
        for sha256 in (SHA_A.upper(), "a" * 63, 7):
            with self.subTest(sha256=sha256):
                with self.assertRaises(DomainInvariantError):
                    FileDigest(1, sha256)  # type: ignore[arg-type]

    def test_rejects_unsafe_names_and_manifest_keys(self) -> None:
        for name in ("", " source.mp4", "../source.mp4", "a/b.mp4", "a\\b.mp4"):
            with self.subTest(name=name):
                with self.assertRaises(DomainInvariantError):
                    SourceIdentity(name, FileDigest(1, SHA_A))
        for key in (
            PurePosixPath("."),
            PurePosixPath("../escape"),
            PurePosixPath("/absolute"),
            PurePosixPath("C:/windows"),
        ):
            with self.subTest(key=key):
                with self.assertRaises(DomainInvariantError):
                    ManifestEntry(key, FileDigest(1, SHA_A))
        with self.assertRaises(DomainInvariantError):
            ManifestEntry("not-a-path", FileDigest(1, SHA_A))  # type: ignore[arg-type]

    def test_rejects_archive_digest_that_differs_from_source(self) -> None:
        source = SourceIdentity("source.mp4", FileDigest(5, SHA_A))
        with self.assertRaises(DomainInvariantError):
            VerifiedInputArchive(
                source,
                entry("inputs/source.mp4", 5, SHA_B),
                "2026-07-16T21:20:00+07:00",
            )

    def test_rejects_unsorted_duplicate_or_colliding_manifest_entries(self) -> None:
        base = manifest()
        with self.assertRaises(DomainInvariantError):
            CheckpointManifest(
                base.version,
                base.checkpoint_id,
                base.job_id,
                base.source,
                base.input_archive,
                base.state_snapshot,
                tuple(reversed(base.artifacts)),
                base.created_at,
            )
        with self.assertRaises(DomainInvariantError):
            CheckpointManifest(
                base.version,
                base.checkpoint_id,
                base.job_id,
                base.source,
                base.input_archive,
                base.state_snapshot,
                (base.artifacts[0], base.artifacts[0]),
                base.created_at,
            )
        with self.assertRaises(DomainInvariantError):
            CheckpointManifest(
                base.version,
                base.checkpoint_id,
                base.job_id,
                base.source,
                base.input_archive,
                base.state_snapshot,
                (base.input_archive,),
                base.created_at,
            )

    def test_rejects_wrong_manifest_version_and_nested_types(self) -> None:
        base = manifest()
        for version in (0, 3, True):
            with self.subTest(version=version):
                with self.assertRaises(DomainInvariantError):
                    CheckpointManifest(
                        version,
                        base.checkpoint_id,
                        base.job_id,
                        base.source,
                        base.input_archive,
                        base.state_snapshot,
                        base.artifacts,
                        base.created_at,
                    )
        with self.assertRaises(DomainInvariantError):
            CheckpointManifest(
                1,
                base.checkpoint_id,
                "job-001",  # type: ignore[arg-type]
                base.source,
                base.input_archive,
                base.state_snapshot,
                base.artifacts,
                base.created_at,
            )


class ManifestSerializationTests(unittest.TestCase):
    def test_versions_one_and_two_have_pinned_canonical_bytes(self) -> None:
        self.assertEqual(canonical_manifest_bytes(manifest(1)), V1_BYTES)
        self.assertEqual(canonical_manifest_bytes(manifest(2)), V2_BYTES)
        self.assertEqual(parse_manifest_bytes(V1_BYTES).version, 1)
        self.assertEqual(parse_manifest_bytes(V2_BYTES).version, 2)
        self.assertEqual(
            canonical_manifest_bytes(parse_manifest_bytes(V1_BYTES)),
            V1_BYTES,
        )
        self.assertEqual(
            canonical_manifest_bytes(parse_manifest_bytes(V2_BYTES)),
            V2_BYTES,
        )

    def test_round_trip_is_canonical_utf8_with_one_trailing_newline(self) -> None:
        expected = manifest()

        raw = canonical_manifest_bytes(expected)

        self.assertTrue(raw.endswith(b"\n"))
        self.assertFalse(raw.endswith(b"\n\n"))
        self.assertEqual(parse_manifest_bytes(raw), expected)
        self.assertEqual(canonical_manifest_bytes(parse_manifest_bytes(raw)), raw)
        decoded = json.loads(raw)
        self.assertEqual(decoded["version"], 1)
        self.assertEqual(decoded["artifacts"][0]["key"], "artifacts/a.json")

    def test_serializer_requires_exact_manifest(self) -> None:
        with self.assertRaises(DomainInvariantError):
            canonical_manifest_bytes({})  # type: ignore[arg-type]

    def test_parser_rejects_non_bytes_and_noncanonical_json(self) -> None:
        canonical = canonical_manifest_bytes(manifest())
        payload = json.loads(canonical)
        variants = (
            canonical.decode("utf-8"),
            json.dumps(payload, indent=2).encode("utf-8"),
            canonical.rstrip(b"\n"),
            canonical + b"\n",
        )
        for raw in variants:
            with self.subTest(raw=raw):
                with self.assertRaises(DomainInvariantError):
                    parse_manifest_bytes(raw)  # type: ignore[arg-type]

    def test_parser_rejects_unknown_missing_and_duplicate_fields(self) -> None:
        payload = json.loads(canonical_manifest_bytes(manifest()))
        unknown = dict(payload, unexpected=True)
        missing = dict(payload)
        del missing["checkpoint_id"]
        duplicate = b'{"version":1,"version":1}\n'
        for raw in (
            json.dumps(unknown, sort_keys=True, separators=(",", ":")).encode() + b"\n",
            json.dumps(missing, sort_keys=True, separators=(",", ":")).encode() + b"\n",
            duplicate,
            b"not-json\n",
            b"\xff\n",
        ):
            with self.subTest(raw=raw):
                with self.assertRaises(DomainInvariantError):
                    parse_manifest_bytes(raw)

    def test_parser_rejects_malformed_nested_entry(self) -> None:
        payload = json.loads(canonical_manifest_bytes(manifest()))
        payload["state_snapshot"]["size_bytes"] = True
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        with self.assertRaises(DomainInvariantError):
            parse_manifest_bytes(raw)

    def test_parser_wraps_escaped_lone_surrogate_as_domain_error(self) -> None:
        raw = canonical_manifest_bytes(manifest()).replace(
            b'"source.mp4"', b'"\\ud800.mp4"'
        )
        with self.assertRaises(DomainInvariantError):
            parse_manifest_bytes(raw)


if __name__ == "__main__":
    unittest.main()
