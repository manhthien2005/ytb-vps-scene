from __future__ import annotations

import json
import unittest

from ytb_vps_v2.adapters.control_plane.http import (
    ControlPlaneClient,
    ControlPlaneError,
    HttpResponse,
)


class FakeTransport:
    def __init__(self) -> None:
        self.response = HttpResponse(200, b'{"state":"READY"}', {})
        self.last_headers: dict[str, str] = {}
        self.last_url = ""

    def request(self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> HttpResponse:
        self.last_headers = dict(headers)
        self.last_url = url
        return self.response


class ControlPlaneHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = FakeTransport()

    def test_bearer_is_header_only_and_errors_never_echo_it(self) -> None:
        secret = "synthetic-secret"
        self.transport.response = HttpResponse(401, b'{"code":"WORKER_SESSION_EXPIRED"}', {})
        client = ControlPlaneClient("https://app.example", secret, transport=self.transport, sleep=lambda _: None)

        with self.assertRaisesRegex(ControlPlaneError, "WORKER_SESSION_EXPIRED") as caught:
            client.heartbeat({"capabilities": {}, "doctor": {}})

        self.assertNotIn(secret, str(caught.exception))
        self.assertEqual(self.transport.last_headers["Authorization"], f"Bearer {secret}")
        self.assertNotIn(secret, self.transport.last_url)

    def test_rejects_non_https_origin_and_cross_origin_redirects(self) -> None:
        with self.assertRaises(ControlPlaneError):
            ControlPlaneClient("http://app.example", "A" * 43, transport=self.transport)
        self.transport.response = HttpResponse(302, b"", {"location": "https://evil.example"})
        client = ControlPlaneClient("https://app.example", "A" * 43, transport=self.transport, sleep=lambda _: None)
        with self.assertRaisesRegex(ControlPlaneError, "REDIRECT"):
            client.heartbeat({"capabilities": {}, "doctor": {}})

    def test_rejects_duplicate_json_and_oversized_responses(self) -> None:
        self.transport.response = HttpResponse(200, b'{"state":"READY","state":"BUSY"}', {})
        client = ControlPlaneClient("https://app.example", "A" * 43, transport=self.transport, sleep=lambda _: None)
        with self.assertRaisesRegex(ControlPlaneError, "JSON"):
            client.heartbeat({"capabilities": {}, "doctor": {}})
        self.transport.response = HttpResponse(200, b"x" * 8193, {})
        with self.assertRaisesRegex(ControlPlaneError, "RESPONSE_TOO_LARGE"):
            client.heartbeat({"capabilities": {}, "doctor": {}})

    def test_classifies_retryable_rate_limit_without_unbounded_retries(self) -> None:
        self.transport.response = HttpResponse(429, b'{"code":"RATE_LIMITED"}', {"retry-after": "30"})
        sleeps: list[float] = []
        client = ControlPlaneClient("https://app.example", "A" * 43, transport=self.transport, sleep=sleeps.append)
        with self.assertRaisesRegex(ControlPlaneError, "RATE_LIMITED") as caught:
            client.heartbeat({"capabilities": {}, "doctor": {}})
        self.assertEqual(caught.exception.retryable, True)
        self.assertLessEqual(len(sleeps), 2)

    def test_enroll_does_not_send_bearer_header(self) -> None:
        self.transport.response = HttpResponse(200, json.dumps({
            "workerId": "10000000-0000-4000-8000-000000000001",
            "sessionSecret": "B" * 43,
            "sessionExpiresAt": "2026-07-21T08:30:00.000Z",
        }).encode(), {})
        client = ControlPlaneClient("https://app.example", None, transport=self.transport, sleep=lambda _: None)
        result = client.enroll("A" * 43, {"capabilities": {}, "doctor": {}})
        self.assertEqual(result["sessionSecret"], "B" * 43)
        self.assertNotIn("Authorization", self.transport.last_headers)

    def test_media_lifecycle_calls_use_fenced_job_paths(self) -> None:
        self.transport.response = HttpResponse(200, b'{"sessionUri":"https://www.googleapis.com/upload/drive/v3/files/file-001?uploadType=resumable&upload_id=x"}', {})
        client = ControlPlaneClient("https://app.example", "A" * 43, transport=self.transport, sleep=lambda _: None)
        client.output_session("job-001", {"fencingToken": 1, "sizeBytes": 10, "checksumSha256": "a" * 64})
        self.assertEqual(self.transport.last_url, "https://app.example/api/v1/worker/jobs/job-001/output-session")
        client.complete("job-001", {"artifactId": "artifact-001", "driveFileId": "file-001", "fencingToken": 1, "sizeBytes": 10})
        self.assertEqual(self.transport.last_url, "https://app.example/api/v1/worker/jobs/job-001/complete")


if __name__ == "__main__":
    unittest.main()
