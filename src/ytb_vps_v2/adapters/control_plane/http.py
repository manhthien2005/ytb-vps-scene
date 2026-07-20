from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes
    headers: Mapping[str, str]


class Transport(Protocol):
    def request(self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> HttpResponse: ...


class ControlPlaneError(RuntimeError):
    def __init__(self, code: str, status: int = 0, *, retryable: bool = False) -> None:
        super().__init__(code)
        self.code = code
        self.status = status
        self.retryable = retryable


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request: Request, fp: Any, code: int, msg: str, headers: Mapping[str, str], newurl: str) -> None:
        return None


class UrllibTransport:
    def __init__(self) -> None:
        self._opener = build_opener(_NoRedirect(), __import__("urllib.request", fromlist=["ProxyHandler"]).ProxyHandler({}))

    def request(self, method: str, url: str, headers: dict[str, str], body: bytes | None, timeout: float) -> HttpResponse:
        request = Request(url, data=body, headers=headers, method=method)
        try:
            response = self._opener.open(request, timeout=timeout)
            return HttpResponse(response.status, _read_bounded(response, 8192), dict(response.headers.items()))
        except HTTPError as error:
            body_bytes = _read_bounded(error, 8192)
            return HttpResponse(error.code, body_bytes, dict(error.headers.items()))
        except (URLError, TimeoutError, OSError) as error:
            raise ControlPlaneError("NETWORK_UNAVAILABLE", 503, retryable=True) from error


def _read_bounded(stream: Any, limit: int) -> bytes:
    body = stream.read(limit + 1)
    if len(body) > limit:
        raise ControlPlaneError("RESPONSE_TOO_LARGE", 502)
    return body


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _decode_json(body: bytes) -> dict[str, Any]:
    try:
        value = json.loads(body.decode("utf-8"), object_pairs_hook=_reject_duplicate_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ControlPlaneError("INVALID_JSON", 502) from error
    if not isinstance(value, dict):
        raise ControlPlaneError("INVALID_JSON", 502)
    return value


class ControlPlaneClient:
    def __init__(
        self,
        origin: str,
        session_secret: str | None,
        *,
        transport: Transport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        timeout: float = 15.0,
    ) -> None:
        from urllib.parse import urlsplit

        parsed = urlsplit(origin)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ControlPlaneError("ORIGIN_INVALID", 400)
        self.origin = origin.rstrip("/")
        self.session_secret = session_secret
        self.transport = transport or UrllibTransport()
        self.sleep = sleep
        self.timeout = timeout

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None, *, authenticated: bool = True) -> dict[str, Any]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if authenticated:
            if self.session_secret is None:
                raise ControlPlaneError("WORKER_AUTH_REQUIRED", 401)
            headers["Authorization"] = f"Bearer {self.session_secret}"
        body = None if payload is None else json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        response: HttpResponse | None = None
        for attempt in range(3):
            try:
                response = self.transport.request(method, f"{self.origin}{path}", headers, body, self.timeout)
            except ControlPlaneError:
                if attempt == 2:
                    raise
                self.sleep(0.25 * (attempt + 1))
                continue
            if response.status == 429 or response.status >= 500:
                if attempt < 2:
                    self.sleep(min(2.0, 0.25 * (attempt + 1)))
                    continue
            break
        assert response is not None
        if len(response.body) > 8192:
            raise ControlPlaneError("RESPONSE_TOO_LARGE", 502)
        if 300 <= response.status < 400:
            raise ControlPlaneError("REDIRECT_REJECTED", 502)
        if response.status == 204:
            return {}
        data = _decode_json(response.body)
        if response.status >= 400:
            code = data.get("code")
            if not isinstance(code, str) or not code or len(code) > 80:
                code = "CONTROL_PLANE_ERROR"
            raise ControlPlaneError(code, response.status, retryable=response.status == 429 or response.status >= 500)
        return data

    def enroll(self, token: str, evidence: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/api/v1/worker/enroll", {"enrollmentToken": token, **evidence}, authenticated=False)

    def heartbeat(self, evidence: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", "/api/v1/worker/heartbeat", evidence)

    def claim(self) -> dict[str, Any] | None:
        result = self._request("POST", "/api/v1/worker/claim")
        return result or None

    def renew(self, job_id: str, fencing_token: int) -> dict[str, Any]:
        return self._request("POST", f"/api/v1/worker/jobs/{job_id}/renew", {"fencingToken": fencing_token})

    def progress(self, job_id: str, update: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", f"/api/v1/worker/jobs/{job_id}/progress", update)

    def output_session(self, job_id: str, request: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", f"/api/v1/worker/jobs/{job_id}/output-session", request)

    def complete(self, job_id: str, request: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", f"/api/v1/worker/jobs/{job_id}/complete", request)
