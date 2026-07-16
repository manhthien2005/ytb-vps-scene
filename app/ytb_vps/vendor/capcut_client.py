"""Minimal CapCut common-task TTS protocol client.

Adapted from the pure-Python CapCut common-task client already supplied with
the user's project. Only the TTS request/signing surface is included here.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import time
import uuid
from copy import deepcopy
from xml.sax.saxutils import escape


BASE = "https://editor-api-sg.capcutapi.com"

DEFAULT_DEVICE = {
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
    "device_id": "7647183892936328721",
    "iid": "7647185302080423697",
    "region": "VN",
    "loc": "VN",
    "lan": "vi-VN",
    "pf": "3",
    "tdid": "7647183892936328721",
}

TTS_SIGN_PUBLIC_KEY_PEM = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmTd34Lw4b7IuldSXh/zY
CMla+ITdGG5TeWz6ad+OySd4r+IrY45AoqrYUxhQ2dl+7z+i7r/5vEa8rr39BYfB
8AGMQLmZA8HmgpWBsqrn/V6daUALkKnkLb70Fn32CJigIuGXAYqxUdGuI340aC+0
v5Es3puJsHyzf01/AelE4Cdc6bZhQrASJLBh8R3BQToYClmDVSDUQk28o8sl/guA
Z4n303Vj+6Siv1HayPCdV6kpVVnMBAG4+umUbwGmn132N3fgpzLarFF3XyWmS1zh
D/J07iM/rP8GDO9IskHNHd2phrO0G6KzrcFAnTBHjVv+hCBEfzN/no3FNA9AuC36
mwIDAQAB
-----END PUBLIC KEY-----"""


def compact_json(value) -> str:
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
        raise ValueError(f"Bad DER tag: expected {tag:#x}, got {data[position]:#x}")
    length, position = _der_len(data, position + 1)
    return data[position : position + length], position + length


def _der_int(data: bytes, position: int) -> tuple[int, int]:
    raw, position = _der_value(data, position, 0x02)
    return int.from_bytes(raw.lstrip(b"\x00"), "big"), position


def rsa_public_numbers_from_pem(pem: str) -> tuple[int, int]:
    encoded = "".join(
        line for line in pem.splitlines() if not line.startswith("-----")
    )
    der = base64.b64decode(encoded)
    outer, position = _der_value(der, 0, 0x30)
    if position != len(der):
        raise ValueError("Trailing public-key data")
    _, position = _der_value(outer, 0, 0x30)
    bit_string, position = _der_value(outer, position, 0x03)
    if position != len(outer) or not bit_string or bit_string[0] != 0:
        raise ValueError("Invalid subjectPublicKeyInfo")
    rsa_sequence, position = _der_value(bit_string[1:], 0, 0x30)
    if position != len(bit_string[1:]):
        raise ValueError("Trailing RSA public-key data")
    modulus, position = _der_int(rsa_sequence, 0)
    exponent, position = _der_int(rsa_sequence, position)
    if position != len(rsa_sequence):
        raise ValueError("Trailing RSA integer data")
    return modulus, exponent


def rsa_encrypt_pkcs1v15(message: str) -> str:
    modulus, exponent = rsa_public_numbers_from_pem(TTS_SIGN_PUBLIC_KEY_PEM)
    key_length = (modulus.bit_length() + 7) // 8
    raw = message.encode("utf-8")
    if len(raw) > key_length - 11:
        raise ValueError("Message is too long for RSA PKCS#1 v1.5")
    padding_length = key_length - len(raw) - 3
    padding = bytearray()
    while len(padding) < padding_length:
        padding.extend(
            value
            for value in secrets.token_bytes(padding_length - len(padding))
            if value
        )
    encoded = b"\x00\x02" + bytes(padding[:padding_length]) + b"\x00" + raw
    encrypted = pow(int.from_bytes(encoded, "big"), exponent, modulus).to_bytes(
        key_length, "big"
    )
    return base64.b64encode(encrypted).decode("ascii")


def make_tts_payload_sign(
    ssml: str, extra_info: str | None, device_id: str, app_id: str
) -> str:
    value = (
        f"appid:{app_id}&did:{device_id}&creditDisable:false&ssml:"
        f"{hashlib.md5(ssml.encode('utf-8')).hexdigest()}"
    )
    if extra_info is not None:
        value += f"&extraInfo:{extra_info}"
    return rsa_encrypt_pkcs1v15(value)


def common_query(device: dict, babi_param=None, include_region: bool = True) -> dict:
    query = {
        key: device[key]
        for key in (
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
    }
    if include_region:
        query["region"] = device["region"]
    if babi_param is not None:
        query["babi_param"] = compact_json(babi_param)
    return query


def make_x_ss_stub(body_text: str) -> str:
    return hashlib.md5(body_text.encode("utf-8")).hexdigest()


def make_sign_header(url: str, appvr: str, device_time: str, tdid: str) -> str:
    path = url.split("?", 1)[0]
    value = f"9e2c|{path[-7:]}|3|{appvr}|{device_time}|{tdid}|11ac"
    return hashlib.md5(value.encode("utf-8")).hexdigest()


def base_headers(device: dict, body_text: str, appid: bool = False) -> dict:
    now = str(int(time.time()))
    trace = uuid.uuid4().hex[:32]
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
        "x-ss-stub": make_x_ss_stub(body_text),
        "x-ss-dp": device["aid"],
        "x-khronos": now,
        "x-tt-trace-id": f"00-{trace}-{trace[:16]}-01",
        "user-agent": "Cronet/TTNetVersion:1d7cc3b1 2025-07-16",
        "accept-encoding": "gzip, deflate",
        "store-country-code": device["loc"].lower(),
        "store-country-code-src": "did",
        "is-dispatch-us-ttp": "0",
        "is-app-region-us-ttp": "0",
    }
    if appid:
        headers["app-sdk-version"] = device["appvr"]
        headers["appid"] = device["aid"]
    return headers


def tts_new_body(
    texts: list[str], voice: str, resource_id: str, rate: str, device: dict
) -> tuple[dict, dict]:
    babi = {
        "feature_entrance": "editor",
        "feature_entrance_detail": "editor-feature-text_to_speech",
        "feature_key": "text_to_speech",
        "scenario": "video_editor",
    }
    blocks = [
        f'    <voice name="{voice}" mock_tone_info="" platform="sami" '
        f'resource_id="{resource_id}" emotion="" emotion_scale="0" style="" '
        f'role="" moyin_emotion="" is_clone_tone="false" '
        f'need_subtitle_timestamp="false">\n'
        f'        <prosody rate="{rate}">{escape(text)}</prosody>\n'
        f"    </voice>"
        for text in texts
    ]
    ssml = (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        'xml:lang="en-US">\n'
        + "\n".join(blocks)
        + "\n</speak>"
    )
    extra = compact_json({"benefit_info": {}})
    payload = {
        "audio_format": "mp3",
        "babi_param": compact_json(babi),
        "credit_disable": False,
        "extra_info": extra,
        "need_merge_voice": False,
        "need_subtitle_timestamp": False,
        "scene": "text_to_speech",
        "ssml": ssml,
    }
    payload["sign"] = make_tts_payload_sign(
        ssml, extra, device["device_id"], device["aid"]
    )
    body = {
        "bind_id": str(uuid.uuid4()),
        "can_queue": True,
        "enter_from": "text_to_speech",
        "tasks": [
            {
                "context": str(uuid.uuid4()),
                "payload": compact_json(payload),
                "req_key": "sami_text_to_speech",
                "task_version": "v3",
            }
        ],
    }
    return babi, body


def query_body(task_id: str, token: str) -> dict:
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


__all__ = [
    "BASE",
    "DEFAULT_DEVICE",
    "base_headers",
    "common_query",
    "compact_json",
    "deepcopy",
    "make_sign_header",
    "query_body",
    "tts_new_body",
]

