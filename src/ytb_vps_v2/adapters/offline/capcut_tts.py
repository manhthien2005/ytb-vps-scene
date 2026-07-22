from __future__ import annotations

import base64
import gzip
import hashlib
import http.client
import ipaddress
import json
import os
import secrets
import socket
import ssl
import subprocess
import tempfile
import time
import uuid
import zlib
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path, PurePosixPath
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from xml.sax.saxutils import escape

from ytb_vps_v2.domain.backup import FileDigest
from ytb_vps_v2.domain.pipeline import (
    TRANSLATION_ARTIFACT_PATH,
    TranslationDocument,
    TtsDocument,
    canonical_document_bytes,
)
from ytb_vps_v2.ports.pipeline import ProviderError, TtsSynthesis

DEFAULT_CAPCUT_VOICE = "BV074_streaming"
DEFAULT_CAPCUT_RESOURCE_ID = "7102355709945188865"
DEFAULT_CAPCUT_DEVICE_PATH = Path("/var/lib/ytb-vps/secrets/capcut-device.json")
DEFAULT_CAPCUT_DEVICE_POOL_DIR = Path("/var/lib/ytb-vps/secrets/capcut-devices")
DEFAULT_TTS_AUDIO_PATH = PurePosixPath("artifacts/tts/voice.wav")
_CAPCUT_BASE = "https://editor-api-sg.capcutapi.com"
_ALLOWED_AUDIO_SUFFIXES = (
    "tiktokcdn.com",
    "bytecdn.com",
    "byteoversea.com",
    "bytedance.com",
    "bytedance.net",
    "capcutapi.com",
)

_DEFAULT_DEVICE = {
    "aid": "359289",
    "app_name": "CapCut",
    "appvr": "8.7.0",
    "version_name": "8.7.0",
    "version_code": "8.7.0",
    "channel": "capcutpc_google",
    "device_platform": "mac",
    "device_type": "MacBookPro17,1",
    "device_brand": "MacBookPro17,1",
    "os_version": "15.7.4",
    "region": "VN",
    "loc": "VN",
    "lan": "vi-VN",
    "pf": "3",
}

_TTS_SIGN_PUBLIC_KEY_PEM = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmTd34Lw4b7IuldSXh/zY
CMla+ITdGG5TeWz6ad+OySd4r+IrY45AoqrYUxhQ2dl+7z+i7r/5vEa8rr39BYfB
8AGMQLmZA8HmgpWBsqrn/V6daUALkKnkLb70Fn32CJigIuGXAYqxUdGuI340aC+0
v5Es3puJsHyzf01/AelE4Cdc6bZhQrASJLBh8R3BQToYClmDVSDUQk28o8sl/guA
Z4n303Vj+6Siv1HayPCdV6kpVVnMBAG4+umUbwGmn132N3fgpzLarFF3XyWmS1zh
D/J07iM/rP8GDO9IskHNHd2phrO0G6KzrcFAnTBHjVv+hCBEfzN/no3FNA9AuC36
mwIDAQAB
-----END PUBLIC KEY-----"""


def _digest(raw: bytes) -> FileDigest:
    return FileDigest(len(raw), hashlib.sha256(raw).hexdigest())


def _dependency(document: object) -> FileDigest:
    return _digest(canonical_document_bytes(document))


def _compact_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _der_len(data: bytes, position: int) -> tuple[int, int]:
    first = data[position]
    position += 1
    if first < 0x80:
        return first, position
    count = first & 0x7F
    return int.from_bytes(data[position : position + count], "big"), position + count


def _der_value(data: bytes, position: int, tag: int) -> tuple[bytes, int]:
    if data[position] != tag:
        raise ProviderError("CapCut RSA public key is invalid")
    length, position = _der_len(data, position + 1)
    return data[position : position + length], position + length


def _der_int(data: bytes, position: int) -> tuple[int, int]:
    raw, position = _der_value(data, position, 0x02)
    return int.from_bytes(raw.lstrip(b"\x00"), "big"), position


def _rsa_public_numbers_from_pem(pem: str) -> tuple[int, int]:
    encoded = "".join(line for line in pem.splitlines() if not line.startswith("-----"))
    der = base64.b64decode(encoded)
    outer, position = _der_value(der, 0, 0x30)
    if position != len(der):
        raise ProviderError("CapCut RSA public key has trailing data")
    _, position = _der_value(outer, 0, 0x30)
    bit_string, position = _der_value(outer, position, 0x03)
    if position != len(outer) or not bit_string or bit_string[0] != 0:
        raise ProviderError("CapCut RSA public key is invalid")
    rsa_sequence, position = _der_value(bit_string[1:], 0, 0x30)
    if position != len(bit_string[1:]):
        raise ProviderError("CapCut RSA public key has trailing data")
    modulus, position = _der_int(rsa_sequence, 0)
    exponent, position = _der_int(rsa_sequence, position)
    if position != len(rsa_sequence):
        raise ProviderError("CapCut RSA public key has trailing data")
    return modulus, exponent


def _rsa_encrypt_pkcs1v15(message: str) -> str:
    modulus, exponent = _rsa_public_numbers_from_pem(_TTS_SIGN_PUBLIC_KEY_PEM)
    key_length = (modulus.bit_length() + 7) // 8
    raw = message.encode("utf-8")
    if len(raw) > key_length - 11:
        raise ProviderError("CapCut TTS request is too large to sign")
    padding_length = key_length - len(raw) - 3
    padding = bytearray()
    while len(padding) < padding_length:
        padding.extend(value for value in secrets.token_bytes(padding_length - len(padding)) if value)
    encoded = b"\x00\x02" + bytes(padding[:padding_length]) + b"\x00" + raw
    encrypted = pow(int.from_bytes(encoded, "big"), exponent, modulus).to_bytes(key_length, "big")
    return base64.b64encode(encrypted).decode("ascii")


def _common_query(device: Mapping[str, str], babi_param: object | None = None, include_region: bool = True) -> dict[str, str]:
    keys = (
        "app_name",
        "device_type",
        "os_version",
        "channel",
        "version_name",
        "device_brand",
        "device_id",
        "iid",
        "version_code",
        "device_platform",
        "aid",
    )
    query = {key: device[key] for key in keys}
    if include_region:
        query["region"] = device["region"]
    if babi_param is not None:
        query["babi_param"] = _compact_json(babi_param)
    return query


def _base_headers(device: Mapping[str, str], url: str, body_text: str) -> dict[str, str]:
    now = str(int(time.time()))
    trace = uuid.uuid4().hex[:32]
    path = url.split("?", 1)[0]
    headers = {
        "content-type": "application/json",
        "appvr": device["appvr"],
        "ch": device["channel"],
        "device-time": now,
        "lan": device["lan"],
        "loc": device["loc"],
        "pf": device["pf"],
        "sign-ver": "1",
        "tdid": device["tdid"],
        "x-ss-stub": hashlib.md5(body_text.encode("utf-8")).hexdigest(),
        "x-ss-dp": device["aid"],
        "x-khronos": now,
        "x-tt-trace-id": f"00-{trace}-{trace[:16]}-01",
        "user-agent": "Cronet/TTNetVersion:1d7cc3b1 2025-07-16",
        "accept-encoding": "gzip, deflate",
        "store-country-code": device["loc"].lower(),
        "store-country-code-src": "did",
        "is-dispatch-us-ttp": "0",
        "is-app-region-us-ttp": "0",
        "app-sdk-version": device["appvr"],
        "appid": device["aid"],
    }
    sign_value = f"9e2c|{path[-7:]}|3|{device['appvr']}|{now}|{device['tdid']}|11ac"
    headers["sign"] = hashlib.md5(sign_value.encode("utf-8")).hexdigest()
    return headers


def _decode_response(raw: bytes, encoding: str | None) -> bytes:
    if encoding == "gzip" or raw.startswith(b"\x1f\x8b"):
        return gzip.decompress(raw)
    if encoding == "deflate":
        return zlib.decompress(raw)
    return raw


def _post_json(url: str, body: Mapping[str, object], device: Mapping[str, str], timeout: float) -> dict[str, object]:
    body_text = _compact_json(body)
    request = Request(url, data=body_text.encode("utf-8"), headers=_base_headers(device, url, body_text), method="POST")
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = _decode_response(response.read(), response.headers.get("content-encoding"))
    except OSError as error:
        raise ProviderError("CapCut TTS request failed") from error
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProviderError("CapCut TTS response is invalid") from error
    if not isinstance(data, dict):
        raise ProviderError("CapCut TTS response is invalid")
    return data


def _is_public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return not (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def _safe_audio_target(value: str, resolver: Callable[[str], Iterable[str]] | None = None) -> tuple[str, str, str]:
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ProviderError("CapCut audio URL is unsafe")
    hostname = parsed.hostname.lower().rstrip(".")
    if not any(hostname == suffix or hostname.endswith(f".{suffix}") for suffix in _ALLOWED_AUDIO_SUFFIXES):
        raise ProviderError("CapCut audio host is not allowed")
    resolve = resolver or _resolve_host
    addresses = tuple(resolve(hostname))
    if not addresses or not all(_is_public_ip(address) for address in addresses):
        raise ProviderError("CapCut audio host resolved to a private address")
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    return hostname, addresses[0], path


def _safe_audio_url(value: str, resolver: Callable[[str], Iterable[str]] | None = None) -> str:
    _safe_audio_target(value, resolver)
    return value


def _resolve_host(hostname: str) -> tuple[str, ...]:
    try:
        return tuple({item[4][0] for item in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)})
    except OSError as error:
        raise ProviderError("CapCut audio host could not be resolved") from error


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, address: str, timeout: float) -> None:
        super().__init__(hostname, timeout=timeout, context=ssl.create_default_context())
        self._validated_address = address

    def connect(self) -> None:
        self.sock = socket.create_connection((self._validated_address, self.port), self.timeout, self.source_address)
        if self._tunnel_host:
            self._tunnel()
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


def _pinned_connection(hostname: str, address: str, timeout: float) -> http.client.HTTPSConnection:
    return _PinnedHTTPSConnection(hostname, address, timeout)


def _download_audio(
    url: str,
    *,
    timeout: float,
    max_bytes: int,
    resolver: Callable[[str], Iterable[str]] | None = None,
    connection_factory: Callable[[str, str, float], object] = _pinned_connection,
) -> bytes:
    hostname, address, path = _safe_audio_target(url, resolver)
    connection = connection_factory(hostname, address, timeout)
    chunks: list[bytes] = []
    size = 0
    try:
        connection.request("GET", path, headers={"user-agent": "Cronet/TTNetVersion:1d7cc3b1 2025-07-16"})  # type: ignore[attr-defined]
        response = connection.getresponse()  # type: ignore[attr-defined]
        if 300 <= response.status < 400:
            raise ProviderError("CapCut audio redirect is not allowed")
        if not 200 <= response.status < 300:
            raise ProviderError("CapCut audio download failed")
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > max_bytes:
                raise ProviderError("CapCut audio is too large")
            chunks.append(chunk)
    except (OSError, http.client.HTTPException) as error:
        raise ProviderError("CapCut audio download failed") from error
    finally:
        connection.close()  # type: ignore[attr-defined]
    audio = b"".join(chunks)
    if len(audio) < 128:
        raise ProviderError("CapCut audio output is empty")
    return audio


def _make_new_body(text: str, voice: str, resource_id: str, rate: str, device: Mapping[str, str]) -> tuple[dict[str, str], dict[str, object]]:
    babi = {
        "feature_entrance": "editor",
        "feature_entrance_detail": "editor-feature-text_to_speech",
        "feature_key": "text_to_speech",
        "scenario": "video_editor",
    }
    ssml = (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">\n'
        f'    <voice name="{voice}" mock_tone_info="" platform="sami" resource_id="{resource_id}" emotion="" emotion_scale="0" style="" role="" moyin_emotion="" is_clone_tone="false" need_subtitle_timestamp="false">\n'
        f'        <prosody rate="{rate}">{escape(text)}</prosody>\n'
        "    </voice>\n"
        "</speak>"
    )
    extra = _compact_json({"benefit_info": {}})
    payload = {
        "audio_format": "mp3",
        "babi_param": _compact_json(babi),
        "credit_disable": False,
        "extra_info": extra,
        "need_merge_voice": False,
        "need_subtitle_timestamp": False,
        "scene": "text_to_speech",
        "ssml": ssml,
    }
    value = f"appid:{device['aid']}&did:{device['device_id']}&creditDisable:false&ssml:{hashlib.md5(ssml.encode('utf-8')).hexdigest()}&extraInfo:{extra}"
    payload["sign"] = _rsa_encrypt_pkcs1v15(value)
    return babi, {
        "bind_id": str(uuid.uuid4()),
        "can_queue": True,
        "enter_from": "text_to_speech",
        "tasks": [
            {
                "context": str(uuid.uuid4()),
                "payload": _compact_json(payload),
                "req_key": "sami_text_to_speech",
                "task_version": "v3",
            }
        ],
    }


def _query_body(task_id: str, token: str) -> dict[str, object]:
    return {
        "tasks": [
            {
                "bind_id": "",
                "id": task_id,
                "req_key": "sami_text_to_speech",
                "task_version": "v3",
                "token": token,
            }
        ]
    }


def _first_audio_url(value: object) -> str | None:
    if isinstance(value, dict):
        for nested in value.values():
            result = _first_audio_url(nested)
            if result:
                return result
    elif isinstance(value, list):
        for nested in value:
            result = _first_audio_url(nested)
            if result:
                return result
    elif isinstance(value, str) and value.startswith(("https://", "http://")):
        return value
    return None


def _task(data: Mapping[str, object]) -> Mapping[str, object]:
    tasks = (data.get("data") or {}) if isinstance(data.get("data"), dict) else {}
    items = tasks.get("tasks") if isinstance(tasks, dict) else None
    if not isinstance(items, list) or not items or not isinstance(items[0], dict):
        return {}
    return items[0]


def _is_shark_block(data: Mapping[str, object]) -> bool:
    text = json.dumps(data, ensure_ascii=False).lower()
    return "shark block" in text or "ret=-6" in text or '"ret":"-6"' in text or '"ret":-6' in text


class CapCutTtsProvider:
    def __init__(
        self,
        *,
        voice: str = DEFAULT_CAPCUT_VOICE,
        resource_id: str = DEFAULT_CAPCUT_RESOURCE_ID,
        rate: float = 1.0,
        ffmpeg: str = "ffmpeg",
        device_path: Path | None = None,
        device_pool_dir: Path | None = None,
        audio_path: PurePosixPath = DEFAULT_TTS_AUDIO_PATH,
        request_json: Callable[[str, Mapping[str, object], Mapping[str, str], float], dict[str, object]] = _post_json,
        download_audio: Callable[[str], bytes] | None = None,
        resolve_audio_host: Callable[[str], Iterable[str]] | None = None,
        query_attempts: int = 40,
        query_interval_seconds: float = 2.0,
        timeout_seconds: float = 60.0,
        max_audio_bytes: int = 50 * 1024 * 1024,
    ) -> None:
        if voice != DEFAULT_CAPCUT_VOICE:
            raise ProviderError("Only CapCut BV074 is supported")
        if resource_id != DEFAULT_CAPCUT_RESOURCE_ID:
            raise ProviderError("Only CapCut BV074 resource is supported")
        if not isinstance(rate, (int, float)) or not 0.8 <= rate <= 1.2:
            raise ProviderError("CapCut TTS rate is invalid")
        if not isinstance(ffmpeg, str) or not ffmpeg.strip():
            raise ProviderError("CapCut TTS FFmpeg executable is invalid")
        if type(audio_path) is not PurePosixPath:
            raise ProviderError("TTS audio path must use portable POSIX format")
        if type(query_attempts) is not int or query_attempts < 1:
            raise ProviderError("CapCut query attempts are invalid")
        self.voice = voice
        self.resource_id = resource_id
        self.rate = float(rate)
        self.ffmpeg = ffmpeg
        self.device_path = device_path or Path(os.environ.get("YTB_VPS_CAPCUT_DEVICE_FILE", str(DEFAULT_CAPCUT_DEVICE_PATH)))
        self.device_pool_dir = device_pool_dir or Path(os.environ.get("YTB_VPS_CAPCUT_DEVICE_POOL_DIR", str(DEFAULT_CAPCUT_DEVICE_POOL_DIR)))
        self.audio_path = audio_path
        self.request_json = request_json
        self.resolve_audio_host = resolve_audio_host
        self.download_audio = download_audio or (lambda url: _download_audio(url, timeout=300.0, max_bytes=max_audio_bytes, resolver=resolve_audio_host))
        self.query_attempts = query_attempts
        self.query_interval_seconds = query_interval_seconds
        self.timeout_seconds = timeout_seconds

    def _device_paths(self) -> tuple[Path, ...]:
        paths: list[Path] = []
        if self.device_path.exists():
            paths.append(self.device_path)
        if self.device_pool_dir.exists():
            paths.extend(sorted(self.device_pool_dir.glob("*.json")))
        unique: list[Path] = []
        seen: set[str] = set()
        for path in paths:
            resolved = path.expanduser().resolve()
            key = str(resolved)
            if key not in seen:
                seen.add(key)
                unique.append(resolved)
        return tuple(unique)

    def _load_device(self, path: Path) -> dict[str, str]:
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as error:
            raise ProviderError("CapCut device credential is invalid") from error
        if not isinstance(raw, dict) or not {"device_id", "iid", "tdid"}.issubset(raw):
            raise ProviderError("CapCut device credential is invalid")
        device = dict(_DEFAULT_DEVICE)
        for key, value in raw.items():
            if isinstance(key, str) and isinstance(value, str):
                device[key] = value
        return device

    def _devices(self) -> tuple[dict[str, str], ...]:
        paths = self._device_paths()
        if not paths:
            raise ProviderError("CapCut device credential is missing")
        return tuple(self._load_device(path) for path in paths)

    def _audio_url(self, text: str, device: Mapping[str, str]) -> str:
        babi, new_body = _make_new_body(text, self.voice, self.resource_id, f"{self.rate:.2f}".rstrip("0").rstrip("."), device)
        new_url = f"{_CAPCUT_BASE}/lv/v1/common_task/new?{urlencode(_common_query(device, babi, include_region=True))}"
        new_data = self.request_json(new_url, new_body, device, self.timeout_seconds)
        task = _task(new_data)
        task_id = task.get("id")
        token = task.get("token")
        if new_data.get("ret") != "0" or not isinstance(task_id, str) or not isinstance(token, str):
            if _is_shark_block(new_data):
                raise ProviderError("CapCut device is shark-blocked")
            raise ProviderError("CapCut TTS task was rejected")
        query_url = f"{_CAPCUT_BASE}/lv/v1/common_task/query?{urlencode(_common_query(device, None, include_region=False))}"
        status = None
        for _ in range(self.query_attempts):
            query_data = self.request_json(query_url, _query_body(task_id, token), device, self.timeout_seconds)
            query_task = _task(query_data)
            status = query_task.get("status")
            payload = query_task.get("payload")
            if status == "succeed" and isinstance(payload, str):
                try:
                    parsed = json.loads(payload)
                except json.JSONDecodeError as error:
                    raise ProviderError("CapCut TTS payload is invalid") from error
                audio_url = _first_audio_url(parsed)
                if audio_url:
                    return _safe_audio_url(audio_url, self.resolve_audio_host)
            if self.query_interval_seconds:
                time.sleep(self.query_interval_seconds)
        raise ProviderError(f"CapCut TTS timed out with status {status}")

    def _mp3_bytes(self, text: str) -> bytes:
        last_error: ProviderError | None = None
        for device in self._devices():
            try:
                return self.download_audio(self._audio_url(text, device))
            except ProviderError as error:
                last_error = error
                if "shark-blocked" not in str(error):
                    raise
        raise last_error or ProviderError("CapCut TTS failed")

    def synthesize(self, translation: TranslationDocument) -> TtsSynthesis:
        if type(translation) is not TranslationDocument:
            raise ProviderError("TTS input must be a TranslationDocument")
        text = " ".join((cue.target_text or cue.source_text).strip() for cue in translation.cues).strip()
        if not text:
            raise ProviderError("CapCut TTS input is empty")
        mp3_bytes = self._mp3_bytes(text)
        with tempfile.TemporaryDirectory(prefix="ytb-capcut-tts-") as directory:
            mp3 = Path(directory) / "voice.mp3"
            wav = Path(directory) / "voice.wav"
            mp3.write_bytes(mp3_bytes)
            try:
                subprocess.run(
                    [self.ffmpeg, "-y", "-v", "error", "-i", str(mp3), "-ac", "1", "-ar", "24000", "-f", "wav", str(wav)],
                    check=True,
                    capture_output=True,
                    timeout=180,
                )
            except (OSError, subprocess.SubprocessError) as error:
                raise ProviderError("CapCut TTS audio conversion failed") from error
            try:
                audio_bytes = wav.read_bytes()
            except OSError as error:
                raise ProviderError("CapCut TTS output is missing") from error
        if not audio_bytes:
            raise ProviderError("CapCut TTS output is empty")
        document = TtsDocument(
            translation.schema_version,
            translation.job_id,
            translation.media_digest,
            translation.frame_count,
            translation.width,
            translation.height,
            TRANSLATION_ARTIFACT_PATH,
            _dependency(translation),
            translation.cues,
            self.audio_path,
            _digest(audio_bytes),
        )
        return TtsSynthesis(document, audio_bytes)


__all__ = [
    "CapCutTtsProvider",
    "DEFAULT_CAPCUT_DEVICE_PATH",
    "DEFAULT_CAPCUT_DEVICE_POOL_DIR",
    "DEFAULT_CAPCUT_RESOURCE_ID",
    "DEFAULT_CAPCUT_VOICE",
    "DEFAULT_TTS_AUDIO_PATH",
    "_safe_audio_url",
]
