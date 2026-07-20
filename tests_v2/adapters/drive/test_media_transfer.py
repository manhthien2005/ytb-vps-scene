from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path

from ytb_vps_v2.adapters.drive.media_transfer import DriveMediaTransfer, DriveTransferError


class _Response:
    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self.headers = {"content-length": str(len(body))}
        self._body = body

    def read(self, size: int = -1) -> bytes:
        if not self._body:
            return b""
        if size < 0:
            value, self._body = self._body, b""
            return value
        value, self._body = self._body[:size], self._body[size:]
        return value

    def close(self) -> None:
        return None


class _Opener:
    def __init__(self, response: _Response) -> None:
        self.response = response
        self.urls: list[str] = []

    def open(self, request, timeout: float):
        self.urls.append(request.full_url)
        return self.response


class DriveMediaTransferTests(unittest.TestCase):
    def test_download_streams_and_verifies_exact_size_and_digest(self) -> None:
        payload = b"video-bytes"
        opener = _Opener(_Response(200, payload))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "source.mp4"
            transfer = DriveMediaTransfer("access-token", opener=opener)
            transfer.download_source(
                "drive-file-001",
                destination,
                len(payload),
                hashlib.sha256(payload).hexdigest(),
            )
            self.assertEqual(destination.read_bytes(), payload)
            self.assertIn("/files/drive-file-001", opener.urls[0])

    def test_download_rejects_redirects_and_preserves_destination(self) -> None:
        opener = _Opener(_Response(302, b"redirect"))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "source.mp4"
            with self.assertRaises(DriveTransferError):
                DriveMediaTransfer("access-token", opener=opener).download_source(
                    "drive-file-001", destination, 8, hashlib.sha256(b"redirect").hexdigest()
                )
            self.assertFalse(destination.exists())

    def test_upload_uses_validated_google_resumable_uri_and_streams_file(self) -> None:
        calls: list[tuple[str, Path, int]] = []
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "output.mp4"
            source.write_bytes(b"output")

            def putter(uri: str, path: Path, size: int) -> int:
                calls.append((uri, path, size))
                return 200

            transfer = DriveMediaTransfer("access-token", putter=putter)
            transfer.upload_resumable(
                "https://www.googleapis.com/upload/drive/v3/files/file-001?uploadType=resumable&upload_id=x",
                source,
                source.stat().st_size,
                hashlib.sha256(b"output").hexdigest(),
            )
        self.assertEqual(calls[0][2], 6)

    def test_upload_rejects_untrusted_session_uri(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "output.mp4"
            source.write_bytes(b"output")
            with self.assertRaises(DriveTransferError):
                DriveMediaTransfer("access-token", putter=lambda *_: 200).upload_resumable(
                    "https://evil.example/upload/drive/v3/files/file?uploadType=resumable&upload_id=x",
                    source,
                    6,
                    hashlib.sha256(b"output").hexdigest(),
                )
