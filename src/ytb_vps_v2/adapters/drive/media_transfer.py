from __future__ import annotations

import hashlib
import http.client
import os
import ssl
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class DriveTransferError(RuntimeError):
    """Raised when a direct Drive media transfer cannot be verified."""


class _Opener(Protocol):
    def open(self, request: Request, timeout: float) -> Any: ...


def _digest(path: Path) -> tuple[int, str]:
    hasher = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            hasher.update(chunk)
    return size, hasher.hexdigest()


def _safe_file_id(value: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 256 or any(char.isspace() for char in value):
        raise DriveTransferError("Drive file id is invalid")
    return value


def _download_opener() -> _Opener:
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            return None

    return build_opener(NoRedirect(), __import__("urllib.request", fromlist=["ProxyHandler"]).ProxyHandler({}))


def _default_putter(uri: str, source: Path, size: int) -> int:
    parsed = urlsplit(uri)
    if parsed.hostname is None:
        raise DriveTransferError("Drive upload hostname is invalid")
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=60)
    try:
        connection.putrequest("PUT", parsed.path + (f"?{parsed.query}" if parsed.query else ""))
        connection.putheader("Content-Length", str(size))
        connection.putheader("Content-Type", "video/mp4")
        connection.endheaders()
        with source.open("rb") as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                connection.send(chunk)
        return connection.getresponse().status
    except (OSError, http.client.HTTPException) as error:
        raise DriveTransferError("Drive upload failed") from error
    finally:
        connection.close()


class DriveMediaTransfer:
    def __init__(
        self,
        access_token: str,
        *,
        opener: _Opener | None = None,
        putter: Callable[[str, Path, int], int] | None = None,
        timeout: float = 60.0,
    ) -> None:
        if not isinstance(access_token, str) or not 1 <= len(access_token) <= 8_192 or any(char.isspace() for char in access_token):
            raise DriveTransferError("Drive access token is invalid")
        if not isinstance(timeout, (int, float)) or timeout <= 0 or timeout > 300:
            raise DriveTransferError("Drive transfer timeout is invalid")
        self.access_token = access_token
        self.opener = opener or _download_opener()
        self.putter = putter or _default_putter
        self.timeout = float(timeout)

    def download_source(
        self,
        file_id: str,
        destination: Path,
        expected_size: int,
        expected_sha256: str,
    ) -> None:
        file_id = _safe_file_id(file_id)
        if not isinstance(destination, Path) or destination.exists() or not isinstance(expected_size, int) or expected_size < 1 or not isinstance(expected_sha256, str) or len(expected_sha256) != 64:
            raise DriveTransferError("Download evidence is invalid")
        destination.parent.mkdir(parents=True, exist_ok=True)
        request = Request(
            f"https://www.googleapis.com/drive/v3/files/{quote(file_id, safe='')}?alt=media",
            headers={"Authorization": f"Bearer {self.access_token}", "Accept": "application/octet-stream"},
            method="GET",
        )
        # uuid-suffixed like every sibling adapter: a deterministic name would let a
        # concurrent/retrying download unlink the other call's in-progress temp file.
        temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.part")
        try:
            response = self.opener.open(request, timeout=self.timeout)
            if response.status != 200:
                raise DriveTransferError("Drive download was not successful")
            written = 0
            with temporary.open("xb") as stream:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    # The expected size is known upfront; abort as soon as the body
                    # exceeds it instead of filling the VPS disk before the digest check.
                    if written > expected_size:
                        raise DriveTransferError("Drive download digest mismatch")
                    stream.write(chunk)
            size, digest = _digest(temporary)
            if size != expected_size or digest != expected_sha256:
                raise DriveTransferError("Drive download digest mismatch")
            os.replace(temporary, destination)
        except DriveTransferError:
            raise
        except (OSError, ValueError) as error:
            raise DriveTransferError("Drive download failed") from error
        finally:
            try:
                response.close()  # type: ignore[union-attr]
            except (NameError, AttributeError, OSError):
                pass
            temporary.unlink(missing_ok=True)

    def upload_resumable(
        self,
        session_uri: str,
        source: Path,
        expected_size: int,
        expected_sha256: str,
    ) -> None:
        parsed = urlsplit(session_uri)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if (
            parsed.scheme != "https" or parsed.hostname != "www.googleapis.com" or
            not parsed.path.startswith("/upload/drive/v3/files/") or
            set(query) != {"uploadType", "upload_id"} or query.get("uploadType") != ["resumable"] or
            not query.get("upload_id") or not isinstance(source, Path) or not source.is_file() or
            not isinstance(expected_size, int) or expected_size < 1 or not isinstance(expected_sha256, str) or len(expected_sha256) != 64
        ):
            raise DriveTransferError("Drive upload session is untrusted")
        size, digest = _digest(source)
        if size != expected_size or digest != expected_sha256:
            raise DriveTransferError("Drive upload digest mismatch")
        status = self.putter(session_uri, source, expected_size)
        if status not in (200, 201):
            raise DriveTransferError("Drive upload was not finalized")
