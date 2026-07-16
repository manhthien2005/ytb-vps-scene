from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, Callable

from PIL import Image

from ytb_vps.config import Settings
from ytb_vps.media import executable, probe_duration, run_ffmpeg
from ytb_vps.ocr import ocr_backend, onnx_ocr_environment
from ytb_vps.util import sha256_file


def _command(command: list[str], *, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        command,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("\n".join((result.stderr or result.stdout).splitlines()[-8:]))
    return result.stdout.strip()


def _meminfo() -> dict[str, int]:
    path = Path("/proc/meminfo")
    if not path.exists():
        return {}
    result = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        number = value.strip().split()[0]
        if number.isdigit():
            result[key] = int(number) * 1024
    return result


def _cpu_flags() -> set[str]:
    path = Path("/proc/cpuinfo")
    if not path.exists():
        return set()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.lower().startswith("flags") and ":" in line:
            return set(line.split(":", 1)[1].split())
    return set()


def _is_wsl() -> bool:
    return "microsoft" in platform.release().lower()


def _ocr_fixture(settings: Settings) -> dict[str, Any]:
    models_root = settings.data_path("models").resolve()
    fixture = models_root / "fixtures" / "ppocrv3-chinese.jpg"
    if not fixture.is_file():
        raise FileNotFoundError(f"OCR fixture is missing: {fixture}")
    with Image.open(fixture) as source:
        image = source.convert("RGB")
        width, height = image.size
        frame = image.tobytes("raw", "BGR")

    ocr = settings.section("ocr")
    backend = ocr_backend(settings)
    with tempfile.TemporaryDirectory(prefix="ytb-vps-ocr-") as folder:
        output_root = Path(folder).resolve()
        output = output_root / "fixture.jsonl"
        common = [
            "--width",
            str(width),
            "--height",
            str(height),
            "--start-frame",
            "0",
            "--expected-frames",
            "1",
            "--language",
            str(ocr["language"]),
            "--gpu-memory-mb",
            str(int(ocr["gpu_memory_mb"])),
            "--crop-min-y-ratio",
            "0",
            "--crop-max-y-ratio",
            "1",
        ]
        environment = None
        if backend == "docker":
            command = [
                executable("docker"),
                "run",
                "--rm",
                "--gpus",
                "all",
                "-i",
                "--network",
                "none",
                "-v",
                f"{models_root}:/models:ro",
                "-v",
                f"{output_root}:/work",
                str(ocr["container_image"]),
                *common,
                "--output",
                "/work/fixture.jsonl",
                "--det-model-dir",
                str(ocr["det_model_dir"]),
                "--rec-model-dir",
                str(ocr["rec_model_dir"]),
            ]
        else:
            onnx_python = Path(str(ocr["onnx_python"]))
            if not onnx_python.is_file():
                raise FileNotFoundError(onnx_python)
            command = [
                str(onnx_python),
                str(Path(str(ocr["onnx_worker"])).resolve(strict=True)),
                *common,
                "--output",
                str(output),
                "--det-model-dir",
                str(models_root / Path(str(ocr["det_model_dir"])).name),
                "--rec-model-dir",
                str(models_root / Path(str(ocr["rec_model_dir"])).name),
            ]
            environment = onnx_ocr_environment(settings)
        result = subprocess.run(
            command,
            input=frame,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            env=environment,
        )
        if result.returncode != 0:
            text = result.stdout.decode("utf-8", errors="replace")
            raise RuntimeError("OCR fixture failed:\n" + "\n".join(text.splitlines()[-12:]))
        detections = [
            json.loads(line)
            for line in output.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        chinese = [
            item
            for item in detections
            if any("\u4e00" <= character <= "\u9fff" for character in str(item.get("text", "")))
        ]
        if not chinese:
            raise RuntimeError("OCR fixture produced no Chinese text")
        texts = {str(item.get("text", "")).strip() for item in detections}
        expected = {"纯臻营养护发素", "产品信息/参数"}
        if not expected.issubset(texts):
            raise RuntimeError(
                f"OCR fixture text mismatch; missing {sorted(expected - texts)}"
            )
        return {
            "detections": len(detections),
            "chinese_detections": len(chinese),
            "sample": [str(item["text"]) for item in chinese[:3]],
        }


def run_doctor(
    settings: Settings, *, live: bool = False, install_only: bool = False
) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def check(
        name: str,
        action: Callable[[], Any],
        *,
        required: bool = True,
    ) -> Any:
        try:
            details = action()
            checks.append({"name": name, "ok": True, "required": required, "details": details})
            return details
        except Exception as exc:
            checks.append({"name": name, "ok": False, "required": required, "error": str(exc)})
            return None

    check(
        "platform",
        lambda: {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
    )
    flags = _cpu_flags()
    check("cpu-flags", lambda: {"avx": "avx" in flags, "expected_no_avx": True}, required=False)
    memory = _meminfo()
    required_swap = int(settings.section("resources")["required_swap_gib"]) * 1024**3

    def memory_check() -> dict[str, Any]:
        swap = memory.get("SwapTotal", 0)
        swap_enforced = not _is_wsl()
        if platform.system() == "Linux" and swap_enforced and swap < required_swap:
            raise RuntimeError(
                f"Swap is {swap / 1024**3:.1f} GiB; need at least {required_swap / 1024**3:.0f} GiB"
            )
        return {
            "ram_gib": round(memory.get("MemTotal", 0) / 1024**3, 2),
            "swap_gib": round(swap / 1024**3, 2),
            "swap_enforced": swap_enforced,
            "warning": (
                "WSL host forbids swapon; strict single-worker limits remain enabled"
                if not swap_enforced and swap < required_swap
                else None
            ),
        }

    check("memory", memory_check)

    def disk_check() -> dict[str, Any]:
        usage = shutil.disk_usage(settings.data_root)
        free_gib = usage.free / 1024**3
        minimum = float(settings.section("resources")["minimum_free_gib"])
        if free_gib < minimum:
            raise RuntimeError(f"Only {free_gib:.1f} GiB free; need {minimum:.1f} GiB")
        details: dict[str, Any] = {"free_gib": round(free_gib, 2)}
        if hasattr(os, "statvfs"):
            stat = os.statvfs(settings.data_root)
            details["free_inodes"] = int(stat.f_favail)
            if stat.f_favail < int(settings.section("resources")["minimum_free_inodes"]):
                raise RuntimeError(f"Only {stat.f_favail} inodes are free")
        return details

    check("disk", disk_check)
    backend = ocr_backend(settings)
    for name in ("ffmpeg", "ffprobe", "rclone", "codex"):
        check(f"executable:{name}", lambda value=name: executable(value))
    if backend == "docker":
        check("executable:docker", lambda: executable("docker"))

    check(
        "subtitle-font",
        lambda: str(Path(settings.section("render")["font_file"]).resolve(strict=True)),
    )
    check(
        "nvidia",
        lambda: _command(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total,driver_version",
                "--format=csv,noheader",
            ]
        ),
    )
    check("ocr-backend", lambda: backend)
    ocr_config = settings.section("ocr")
    if backend == "docker":
        image = str(ocr_config["container_image"])
        check("ocr-image", lambda: _command(["docker", "image", "inspect", image]))
        check(
            "ocr-gpu-runtime",
            lambda: json.loads(_command(["docker", "run", "--rm", "--gpus", "all", image, "--smoke"]).splitlines()[-1]),
        )
    else:
        check(
            "ocr-gpu-runtime",
            lambda: json.loads(
                _command(
                    [
                        str(Path(str(ocr_config["onnx_python"]))),
                        str(Path(str(ocr_config["onnx_worker"])).resolve(strict=True)),
                        "--smoke",
                    ],
                    env=onnx_ocr_environment(settings),
                ).splitlines()[-1]
            ),
        )

    def model_check() -> dict[str, Any]:
        if backend == "onnx":
            return {"models": "RapidOCR bundled ONNX models", "backend": backend}
        root = settings.data_path("models")
        names = [
            Path(str(settings.section("ocr")["det_model_dir"])).name,
            Path(str(settings.section("ocr")["rec_model_dir"])).name,
        ]
        missing = [name for name in names if not (root / name / "inference.pdmodel").exists()]
        if missing:
            raise FileNotFoundError(f"OCR models are missing: {missing}")
        return {"models": names}

    check("ocr-models", model_check)
    check("ocr-known-fixture", lambda: _ocr_fixture(settings))

    if not install_only:
        device_path = Path(settings.section("tts")["device_json"])

        def capcut_credential() -> dict[str, Any]:
            data = json.loads(device_path.read_text(encoding="utf-8-sig"))
            required = {"device_id", "iid", "tdid"}
            if not required.issubset(data):
                raise RuntimeError(f"CapCut credential is missing {sorted(required - set(data))}")
            return {"path": str(device_path), "keys": sorted(required)}

        check("capcut-credential", capcut_credential)
        from ytb_vps.translation import codex_environment

        environment = codex_environment(settings)
        check(
            "codex-login",
            lambda: _command(
                [str(settings.section("translation")["codex_executable"]), "login", "status"],
                env=environment,
            ),
        )
        check(
            "rclone-config",
            lambda: _command(
                [
                    "rclone",
                    "--config",
                    str(settings.section("drive")["config_file"]),
                    "listremotes",
                ]
            ),
        )

    if live:
        def drive_live() -> dict[str, Any]:
            root = str(settings.section("drive")["remote_root"])
            config_file = str(settings.section("drive")["config_file"])
            token = uuid.uuid4().hex
            remote = f"{root.rstrip('/')}/doctor/{token}.txt"
            with tempfile.TemporaryDirectory(prefix="ytb-vps-drive-") as folder:
                source = Path(folder) / "source.txt"
                restored = Path(folder) / "restored.txt"
                source.write_text(f"ytb-vps doctor {token}\n", encoding="utf-8")
                try:
                    _command(["rclone", "--config", config_file, "copyto", str(source), remote, "--checksum"])
                    _command(["rclone", "--config", config_file, "copyto", remote, str(restored), "--checksum"])
                    expected = sha256_file(source)
                    actual = sha256_file(restored)
                    if expected != actual:
                        raise RuntimeError("Drive round-trip checksum mismatch")
                    return {"remote": remote, "checksum": expected}
                finally:
                    try:
                        _command(["rclone", "--config", config_file, "deletefile", remote])
                    except Exception:
                        pass

        check("drive-live", drive_live)

        def codex_live() -> dict[int, str]:
            from ytb_vps.translation import CodexTranslator

            with tempfile.TemporaryDirectory(prefix="ytb-vps-codex-") as folder:
                translator = CodexTranslator(settings, Path(folder), __import__("logging").getLogger("doctor"))
                return translator.translate_entries(
                    [
                        {"cue_index": 1, "source_text": "你好", "source_hash": "doctor-1"},
                        {"cue_index": 2, "source_text": "谢谢", "source_hash": "doctor-2"},
                    ]
                )

        check("codex-live", codex_live)

        def capcut_live() -> dict[str, Any]:
            from ytb_vps.tts import CapCutClient

            with tempfile.TemporaryDirectory(prefix="ytb-vps-capcut-") as folder:
                output = Path(folder) / "smoke.mp3"
                CapCutClient(settings.section("tts")).synthesize("Xin chào", output)
                return {"bytes": output.stat().st_size, "seconds": probe_duration(output)}

        check("capcut-live", capcut_live)

        def ffmpeg_live() -> dict[str, Any]:
            with tempfile.TemporaryDirectory(prefix="ytb-vps-ffmpeg-") as folder:
                output = Path(folder) / "smoke.mp4"
                run_ffmpeg(
                    [
                        "-y",
                        "-f",
                        "lavfi",
                        "-i",
                        "color=c=blue:s=320x180:r=30:d=1",
                        "-f",
                        "lavfi",
                        "-i",
                        "anullsrc=r=44100:cl=stereo",
                        "-t",
                        "1",
                        "-c:v",
                        "libx264",
                        "-pix_fmt",
                        "yuv420p",
                        "-c:a",
                        "aac",
                        str(output),
                    ],
                    duration_seconds=1,
                )
                return {"bytes": output.stat().st_size}

        check("ffmpeg-live", ffmpeg_live)

    ok = all(item["ok"] or not item["required"] for item in checks)
    return {"ok": ok, "mode": "live" if live else "installed", "checks": checks}
