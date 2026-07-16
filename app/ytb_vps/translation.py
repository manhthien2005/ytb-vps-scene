from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Sequence

from ytb_vps.config import Settings
from ytb_vps.state import JobStore
from ytb_vps.util import atomic_write_json, config_fingerprint


class TranslationError(RuntimeError):
    pass

def codex_environment(settings: Settings) -> dict[str, str]:
    environment = os.environ.copy()
    codex_home = settings.secrets_root / "codex"
    environment["CODEX_HOME"] = str(codex_home)
    env_file = codex_home / "env"
    if env_file.exists():
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key:
                environment[key] = value.strip().strip('"').strip("'")
    return environment


def _schema(ids: Sequence[int]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["translations"],
        "properties": {
            "translations": {
                "type": "array",
                "minItems": len(ids),
                "maxItems": len(ids),
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["id", "text"],
                    "properties": {
                        "id": {"type": "integer", "enum": list(ids)},
                        "text": {"type": "string", "minLength": 1},
                    },
                },
            }
        },
    }


def _cue_duration_seconds(item: dict[str, Any]) -> float:
    frames = max(1, int(item.get("end_frame", 0)) - int(item.get("start_frame", 0)))
    fps = float(item.get("fps") or 30)
    return frames / max(1.0, fps)


def _character_budget(seconds: float) -> int:
    if seconds <= 0.8:
        return 12
    if seconds <= 1.2:
        return 18
    if seconds <= 1.8:
        return 28
    if seconds <= 2.5:
        return 40
    return min(62, max(44, int(round(seconds * 18))))


PROMPT_REVISION = 10
STORY_BIBLE_PROMPT_REVISION = 2
HOOK_PROMPT_REVISION = 1


def _prompt_source_path(config: dict[str, Any] | None = None) -> Path:
    configured = str((config or {}).get("prompt_source") or "").strip()
    candidates = (
        Path(configured).expanduser() if configured else None,
        Path(__file__).resolve().parents[2] / "prompt_dich_sub_trung_ke_chuyen.txt",
        Path.cwd() / "prompt_dich_sub_trung_ke_chuyen.txt",
    )
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate.resolve()
    raise TranslationError("Translation prompt source prompt_dich_sub_trung_ke_chuyen.txt is missing")


@lru_cache(maxsize=8)
def _prompt_sections(path_value: str) -> dict[str, str]:
    source = Path(path_value).read_text(encoding="utf-8")
    sections: dict[str, str] = {}
    for name in ("COMMON", "BIBLE", "HOOK", "TRANSLATE"):
        marker = rf"<!--\s*VPS_ADAPTER_{name}_START\s*-->(.*?)<!--\s*VPS_ADAPTER_{name}_END\s*-->"
        match = re.search(marker, source, flags=re.DOTALL)
        if match is None:
            raise TranslationError(f"Translation prompt source is missing VPS_ADAPTER_{name}")
        sections[name] = match.group(1).strip()
    return sections


def _adapter(name: str, prompt_source: Path | None = None) -> str:
    return _prompt_sections(str(prompt_source or _prompt_source_path()))[name]


def _context_payload(entries: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "id": int(item["cue_index"]),
            "chinese": str(item["source_text"]),
            "vietnamese": str(item.get("target_text") or ""),
        }
        for item in entries
    ]


def _prompt(
    entries: Sequence[dict[str, Any]],
    context_entries: Sequence[dict[str, Any]] | None = None,
    *,
    story_bible: dict[str, Any] | None = None,
    prompt_source: Path | None = None,
) -> str:
    requested = [
        {
            "id": int(item["cue_index"]),
            "start_frame": int(item.get("start_frame", 0)),
            "end_frame": int(item.get("end_frame", 0)),
            "seconds": round(_cue_duration_seconds(item), 3),
            "chinese": str(item["source_text"]),
        }
        for item in entries
    ]
    return (
        f"{_adapter('COMMON', prompt_source)}\n\n"
        f"{_adapter('TRANSLATE', prompt_source)}\n\n"
        "Ràng buộc pipeline:\n"
        "- Chỉ trả JSON đúng schema, không markdown, ghi chú, [HOOK] hay [SRT].\n"
        "- `seconds` là mục tiêu đọc, không được dùng để bỏ "
        "ý chính, phủ định, câu hỏi, chủ thể hoặc lượt đáp. TTS sẽ xử lý câu quá dài sau.\n"
        "- Mỗi ranh giới cue là một lượt nói/hành động có thể đổi người. Mặc định trả mỗi cue "
        "thành một câu Việt hoàn chỉnh, có dấu câu phù hợp; không nối cue trước/sau thành một câu. "
        "Chỉ tiếp tục câu khi nguồn chứng minh rõ đó là cùng một câu ngữ pháp, cùng người nói.\n"
        "- Xóa nhiễu OCR rõ ràng theo ngữ cảnh, nhưng không bịa chi tiết.\n\n"
        "story_bible (chỉ để đọc):\n"
        + json.dumps(story_bible or {}, ensure_ascii=False)
        + "\n\nsurrounding_context (chỉ để đọc):\n"
        + json.dumps(_context_payload(context_entries or entries), ensure_ascii=False)
        + "\n\nrequested_entries:\n"
        + json.dumps(requested, ensure_ascii=False)
    )

def _shorten_prompt(
    entries: Sequence[dict[str, Any]],
    context_entries: Sequence[dict[str, Any]],
    *,
    slot_seconds: float,
    required_speed: float,
    hard_speed: float,
) -> str:
    current_characters = sum(len(str(item.get("target_text") or "")) for item in entries)
    target_characters = max(
        len(entries),
        int(current_characters * hard_speed / max(required_speed, hard_speed) * 0.90),
    )
    remaining = target_characters
    payload = []
    for position, item in enumerate(entries):
        current = str(item.get("target_text") or "")
        if position == len(entries) - 1:
            budget = max(1, remaining)
        else:
            share = len(current) / max(1, current_characters)
            budget = max(1, int(round(target_characters * share)))
            remaining -= budget
        payload.append(
            {
                "id": int(item["cue_index"]),
                "chinese": str(item["source_text"]),
                "current_vietnamese": current,
                "maximum_vietnamese_characters": budget,
            }
        )
    return (
        "Shorten the requested Vietnamese subtitle lines so a Vietnamese narrator can finish "
        f"the whole group inside {slot_seconds:.3f} seconds at no more than {hard_speed:.2f}x "
        f"speed. The current audio would require {required_speed:.3f}x.\n\n"
        "Rules:\n"
        "- Preserve the plot meaning, names, point of view, and whether each line is narration, "
        "dialogue, or inner monologue.\n"
        "- Write compact natural Vietnamese for spoken narration, not abbreviations or fragments. "
        "Keep a direct reply, question, negation, and turn boundary in its original cue.\n"
        "- Remove repetition, filler, redundant subjects, and unnecessary honorifics first.\n"
        "- Respect maximum_vietnamese_characters for every requested id.\n"
        "- Do not add facts, notes, speaker labels, markdown, or explanations.\n"
        "- Return exactly one non-empty translation for every requested id.\n\n"
        "surrounding_context (read only):\n"
        + json.dumps(_context_payload(context_entries), ensure_ascii=False)
        + "\n\nrequested_entries:\n"
        + json.dumps(payload, ensure_ascii=False)
    )


def _validate(data: Any, ids: Sequence[int]) -> dict[int, str]:
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict) and isinstance(data.get("translations"), list):
        items = data["translations"]
    else:
        raise TranslationError("Codex result has no translations array")
    result: dict[int, str] = {}
    for item in items:
        if not isinstance(item, dict):
            raise TranslationError("Codex returned a non-object entry")
        identifier = int(item.get("id"))
        text_value = (
            item.get("text")
            or item.get("vietnamese")
            or item.get("translation")
            or item.get("target_text")
            or ""
        )
        text = " ".join(str(text_value).split())
        if not text:
            continue
        if identifier in result:
            if len(text) > len(result[identifier]):
                result[identifier] = text
            continue
        result[identifier] = text
    if set(result) != set(ids):
        raise TranslationError(
            f"Codex IDs do not match: {sorted(result)} != {sorted(ids)}"
        )
    return result


def _story_bible_schema() -> dict[str, Any]:
    items = {"type": "array", "items": {"type": "string"}, "maxItems": 48}
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["summary", "narrative", "characters", "relationships", "terms", "timeline", "translation_rules", "safe_teasers"],
        "properties": {
            "summary": {"type": "string", "minLength": 1, "maxLength": 1800},
            "narrative": {"type": "string", "minLength": 1, "maxLength": 800},
            "characters": items,
            "relationships": items,
            "terms": items,
            "timeline": items,
            "translation_rules": items,
            "safe_teasers": items,
        },
    }


def _hook_schema(ids: Sequence[int]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["mode", "replacements"],
        "properties": {
            "mode": {"type": "string", "enum": ["replace", "original"]},
            "replacements": {
                "type": "array",
                "maxItems": len(ids),
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["id", "text"],
                    "properties": {
                        "id": {"type": "integer", "enum": list(ids)},
                        "text": {"type": "string", "minLength": 1},
                    },
                },
            },
        },
    }


def _source_payload(cues: Sequence[dict[str, Any]], fps: int) -> list[dict[str, Any]]:
    return [
        {
            "id": int(cue["cue_index"]),
            "start_seconds": round(int(cue["start_frame"]) / fps, 3),
            "end_seconds": round(int(cue["end_frame"]) / fps, 3),
            "chinese": str(cue["source_text"]),
        }
        for cue in cues
    ]


def _validate_story_bible(data: Any) -> dict[str, Any]:
    keys = (
        "summary",
        "narrative",
        "characters",
        "relationships",
        "terms",
        "timeline",
        "translation_rules",
        "safe_teasers",
    )
    if not isinstance(data, dict) or set(data) != set(keys):
        raise TranslationError("Codex story bible has an invalid schema")
    result: dict[str, Any] = {
        key: " ".join(str(data[key]).split()) for key in ("summary", "narrative")
    }
    if not all(result.values()):
        raise TranslationError("Codex story bible summary or narrative is empty")
    for key in keys[2:]:
        if not isinstance(data[key], list):
            raise TranslationError(f"Codex story bible {key} is not an array")
        result[key] = [" ".join(str(value).split()) for value in data[key] if str(value).strip()]
    return result


def _validate_hook(data: Any, cues: Sequence[dict[str, Any]], fps: int) -> dict[str, Any]:
    if not isinstance(data, dict) or set(data) != {"mode", "replacements"}:
        raise TranslationError("Codex hook has an invalid schema")
    if data["mode"] == "original" and data["replacements"] == []:
        return {"mode": "original", "replacements": []}
    if data["mode"] != "replace" or not isinstance(data["replacements"], list):
        raise TranslationError("Codex hook has an invalid mode")
    budgets = {
        int(cue["cue_index"]): _character_budget(
            _cue_duration_seconds({**cue, "fps": fps})
        )
        for cue in cues
    }
    replacements: dict[int, str] = {}
    for item in data["replacements"]:
        if not isinstance(item, dict):
            raise TranslationError("Codex hook returned a non-object replacement")
        identifier = int(item.get("id"))
        text = " ".join(str(item.get("text") or "").split())
        if identifier not in budgets or not text or identifier in replacements:
            raise TranslationError("Codex hook replacements do not match hook cues")
        if len(text) > budgets[identifier]:
            raise TranslationError(f"Codex hook cue {identifier} exceeds its character budget")
        replacements[identifier] = text
    if set(replacements) != set(budgets):
        raise TranslationError("Codex hook must replace every hook cue")
    return {
        "mode": "replace",
        "replacements": [{"id": identifier, "text": replacements[identifier]} for identifier in sorted(replacements)],
    }


class CodexTranslator:
    def __init__(
        self,
        settings: Settings,
        workspace: Path,
        logger: logging.Logger,
    ) -> None:
        self.settings = settings
        self.workspace = workspace
        self.logger = logger
        self.config = settings.section("translation")
        self.prompt_source = _prompt_source_path(self.config)
        self.cache = workspace / "translation" / "cache"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.schema_dir = workspace / "translation" / "schemas"
        self.schema_dir.mkdir(parents=True, exist_ok=True)

    @property
    def model(self) -> str:
        return str(self.config.get("model") or "codex-config-default")

    def _run_prompt(
        self,
        entries: Sequence[dict[str, Any]],
        *,
        prompt: str,
        signature_payload: dict[str, Any],
        cache_prefix: str,
    ) -> dict[int, str]:
        ids = [int(item["cue_index"]) for item in entries]
        signature = config_fingerprint(signature_payload)
        cache_path = self.cache / (
            f"{cache_prefix}_{ids[0]:06d}_{ids[-1]:06d}_{signature[:12]}.json"
        )
        if cache_path.exists():
            return _validate(json.loads(cache_path.read_text(encoding="utf-8")), ids)

        schema_path = self.schema_dir / f"schema_{signature[:12]}.json"
        atomic_write_json(schema_path, _schema(ids))
        output_path = cache_path.with_suffix(".result.part")
        output_path.unlink(missing_ok=True)
        command = [
            str(self.config["codex_executable"]),
            "exec",
            "--ignore-rules",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
        ]
        model = str(self.config.get("model") or "").strip()
        if model:
            command.extend(["-m", model])
        command.extend(
            [
                "-C",
                str(self.workspace),
                "--output-schema",
                str(schema_path),
                "-o",
                str(output_path),
                "-",
            ]
        )
        environment = codex_environment(self.settings)
        try:
            result = subprocess.run(
                command,
                input=prompt,
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=float(self.config["timeout_seconds"]),
                check=False,
                env=environment,
            )
        except subprocess.TimeoutExpired as exc:
            output_path.unlink(missing_ok=True)
            raise TranslationError(f"Codex timed out for IDs {ids[0]}-{ids[-1]}") from exc
        if result.returncode != 0 or not output_path.exists():
            output_path.unlink(missing_ok=True)
            tail = "\n".join(result.stderr.splitlines()[-12:])
            raise TranslationError(f"Codex failed for IDs {ids[0]}-{ids[-1]}:\n{tail}")
        data = json.loads(output_path.read_text(encoding="utf-8"))
        validated = _validate(data, ids)
        atomic_write_json(cache_path, data)
        output_path.unlink(missing_ok=True)
        return validated

    def _run_json(
        self,
        *,
        prompt: str,
        schema: dict[str, Any],
        signature_payload: dict[str, Any],
        cache_prefix: str,
        label: str,
        validate: Callable[[Any], Any] | None = None,
    ) -> Any:
        signature = config_fingerprint(signature_payload)
        cache_path = self.cache / f"{cache_prefix}_{signature[:12]}.json"
        if cache_path.exists():
            try:
                cached = json.loads(cache_path.read_text(encoding="utf-8"))
                return validate(cached) if validate is not None else cached
            except (json.JSONDecodeError, TranslationError):
                cache_path.unlink(missing_ok=True)
        schema_path = self.schema_dir / f"schema_{signature[:12]}.json"
        atomic_write_json(schema_path, schema)
        output_path = cache_path.with_suffix(".result.part")
        output_path.unlink(missing_ok=True)
        command = [
            str(self.config["codex_executable"]),
            "exec",
            "--ignore-rules",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
        ]
        if self.model != "codex-config-default":
            command.extend(["-m", self.model])
        command.extend(["-C", str(self.workspace), "--output-schema", str(schema_path), "-o", str(output_path), "-"])
        try:
            result = subprocess.run(
                command,
                input=prompt,
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=float(self.config["timeout_seconds"]),
                check=False,
                env=codex_environment(self.settings),
            )
        except subprocess.TimeoutExpired as exc:
            output_path.unlink(missing_ok=True)
            raise TranslationError(f"Codex timed out for {label}") from exc
        if result.returncode != 0 or not output_path.exists():
            output_path.unlink(missing_ok=True)
            tail = "\n".join(result.stderr.splitlines()[-12:])
            raise TranslationError(f"Codex failed for {label}:\n{tail}")
        try:
            data = json.loads(output_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise TranslationError(f"Codex returned invalid JSON for {label}") from exc
        finally:
            output_path.unlink(missing_ok=True)
        validated = validate(data) if validate is not None else data
        atomic_write_json(cache_path, data)
        return validated

    def _call(
        self,
        entries: Sequence[dict[str, Any]],
        context_entries: Sequence[dict[str, Any]],
        story_bible: dict[str, Any] | None,
    ) -> dict[int, str]:
        return self._run_prompt(
            entries,
            prompt=_prompt(
                entries,
                context_entries,
                story_bible=story_bible,
                prompt_source=self.prompt_source,
            ),
            signature_payload={
                "purpose": "translate",
                "prompt_revision": PROMPT_REVISION,
                "version": int(self.config.get("style_version", 2)),
                "model": self.config.get("model") or "codex-config-default",
                "entries": [
                    [item["cue_index"], item["source_hash"]] for item in entries
                ],
                "context": [
                    [item["cue_index"], item["source_hash"], item.get("target_text") or ""]
                    for item in context_entries
                ],
                "story_bible": story_bible or {},
            },
            cache_prefix="batch",
        )

    def translate_entries(
        self,
        entries: Sequence[dict[str, Any]],
        *,
        context_entries: Sequence[dict[str, Any]] | None = None,
        story_bible: dict[str, Any] | None = None,
        skipped_errors: dict[int, str] | None = None,
    ) -> dict[int, str]:
        context_entries = tuple(context_entries or entries)
        attempts = int(self.config["retry_attempts"])
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                return self._call(entries, context_entries, story_bible)
            except Exception as exc:
                last_error = exc
                self.logger.warning(
                    "Codex batch %s-%s attempt %d failed: %s",
                    entries[0]["cue_index"],
                    entries[-1]["cue_index"],
                    attempt,
                    exc,
                )
        if len(entries) > 1:
            midpoint = len(entries) // 2
            left = self.translate_entries(
                entries[:midpoint],
                context_entries=context_entries,
                story_bible=story_bible,
                skipped_errors=skipped_errors,
            )
            right = self.translate_entries(
                entries[midpoint:],
                context_entries=context_entries,
                story_bible=story_bible,
                skipped_errors=skipped_errors,
            )
            return {**left, **right}
        if bool(self.config.get("skip_failed_cues", True)):
            cue_index = int(entries[0]["cue_index"])
            message = str(last_error or "translation failed")[:500]
            if skipped_errors is not None:
                skipped_errors[cue_index] = message
            self.logger.error("Skipping untranslated cue %s: %s", cue_index, message)
            return {}
        raise TranslationError(str(last_error))

    def story_bible(self, cues: Sequence[dict[str, Any]], *, fps: int) -> dict[str, Any]:
        segment_size = max(1, int(self.config.get("story_bible_segment_cues", 350)))
        if len(cues) > segment_size:
            analyses = [
                self.story_bible(cues[index : index + segment_size], fps=fps)
                for index in range(0, len(cues), segment_size)
            ]
            prompt = (
                f"{_adapter('COMMON', self.prompt_source)}\\n\\n"
                f"{_adapter('BIBLE', self.prompt_source)}\\n\\n"
                "Synthesize the chronological analyses into one authoritative Vietnamese translation brief. "
                "Preserve plot order, narrator voice, relationships, forms of address, terminology, emotional progression, and natural Vietnamese wording rules. Do not invent facts or translate individual cues.\\n\\nsegment_analyses:\\n"
                + json.dumps(analyses, ensure_ascii=False)
            )
            return self._run_json(
                prompt=prompt,
                schema=_story_bible_schema(),
                signature_payload={"purpose": "story-bible-synthesis", "prompt_revision": STORY_BIBLE_PROMPT_REVISION, "model": self.model, "analyses": analyses},
                cache_prefix="story-bible",
                label="story bible synthesis",
                validate=_validate_story_bible,
            )
        prompt = (
            f"{_adapter('COMMON', self.prompt_source)}\n\n"
            f"{_adapter('BIBLE', self.prompt_source)}\n\n"
            "Chỉ trả JSON đúng schema. Mỗi mảng phải ngắn, chỉ chứa dữ kiện cần "
            "cho dịch cue nhất quán.\n\nsource_cues:\n"
            + json.dumps(_source_payload(cues, fps), ensure_ascii=False)
        )
        data = self._run_json(
            prompt=prompt,
            schema=_story_bible_schema(),
            signature_payload={
                "purpose": "story-bible",
                "prompt_revision": STORY_BIBLE_PROMPT_REVISION,
                "model": self.model,
                "cues": _source_payload(cues, fps),
            },
            cache_prefix="story-bible",
            label="story bible",
            validate=_validate_story_bible,
        )
        return data

    def hook(
        self,
        cues: Sequence[dict[str, Any]],
        hook_cues: Sequence[dict[str, Any]],
        *,
        fps: int,
        story_bible: dict[str, Any],
    ) -> dict[str, Any]:
        payload = []
        for cue in hook_cues:
            duration = _cue_duration_seconds({**cue, "fps": fps})
            payload.append(
                {
                    "id": int(cue["cue_index"]),
                    "start_seconds": round(int(cue["start_frame"]) / fps, 3),
                    "end_seconds": round(int(cue["end_frame"]) / fps, 3),
                    "vietnamese_character_budget": _character_budget(duration),
                    "chinese": str(cue["source_text"]),
                }
            )
        prompt = (
            f"{_adapter('COMMON', self.prompt_source)}\n\n"
            f"{_adapter('HOOK', self.prompt_source)}\n\n"
            "Chỉ trả JSON đúng schema. `replace` bắt buộc trả đúng một text cho từng "
            "hook cue; `original` bắt buộc có replacements rỗng.\n\nstory_bible:\n"
            + json.dumps(story_bible, ensure_ascii=False)
            + "\n\nhook_cues:\n"
            + json.dumps(payload, ensure_ascii=False)
            + "\n\nsource_cues:\n"
            + json.dumps(_source_payload(cues, fps), ensure_ascii=False)
        )
        data = self._run_json(
            prompt=prompt,
            schema=_hook_schema([int(cue["cue_index"]) for cue in hook_cues]),
            signature_payload={
                "purpose": "hook",
                "prompt_revision": HOOK_PROMPT_REVISION,
                "model": self.model,
                "cues": _source_payload(cues, fps),
                "story_bible": story_bible,
            },
            cache_prefix="hook",
            label="opening hook",
            validate=lambda result: _validate_hook(result, hook_cues, fps),
        )
        return data

    def shorten_entries(
        self,
        entries: Sequence[dict[str, Any]],
        *,
        context_entries: Sequence[dict[str, Any]],
        slot_seconds: float,
        required_speed: float,
        hard_speed: float,
    ) -> dict[int, str]:
        prompt = _shorten_prompt(
            entries,
            context_entries,
            slot_seconds=slot_seconds,
            required_speed=required_speed,
            hard_speed=hard_speed,
        )
        attempts = int(self.config["retry_attempts"])
        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                return self._run_prompt(
                    entries,
                    prompt=prompt,
                    signature_payload={
                        "purpose": "shorten-tts",
                        "prompt_revision": PROMPT_REVISION,
                        "version": int(self.config.get("style_version", 2)),
                        "model": self.config.get("model") or "codex-config-default",
                        "slot_seconds": round(slot_seconds, 3),
                        "required_speed": round(required_speed, 3),
                        "hard_speed": round(hard_speed, 3),
                        "entries": [
                            [item["cue_index"], item["source_hash"], item.get("target_text") or ""]
                            for item in entries
                        ],
                    },
                    cache_prefix="shorten",
                )
            except Exception as exc:
                last_error = exc
                self.logger.warning(
                    "Codex shorten cues %s-%s attempt %d failed: %s",
                    entries[0]["cue_index"],
                    entries[-1]["cue_index"],
                    attempt,
                    exc,
                )
        raise TranslationError(str(last_error))


def _cue_fingerprint(cues: Sequence[dict[str, Any]], *, fps: int) -> str:
    return config_fingerprint(
        {
            "fps": int(fps),
            "cues": [
                [cue["cue_index"], cue["start_frame"], cue["end_frame"], cue["source_hash"]]
                for cue in cues
            ],
        }
    )


def _matching_prepass(
    row: dict[str, Any] | None,
    *,
    source_fingerprint: str,
    prompt_revision: int,
    model: str,
) -> bool:
    return bool(
        row
        and row["source_fingerprint"] == source_fingerprint
        and int(row["prompt_revision"]) == prompt_revision
        and row["model"] == model
    )


def _hook_replacement_ids(row: dict[str, Any] | None) -> list[int]:
    payload = row.get("payload") if row else None
    if not isinstance(payload, dict) or payload.get("mode") != "replace":
        return []
    return [
        int(item["id"])
        for item in payload.get("replacements", [])
        if isinstance(item, dict) and "id" in item
    ]


def _hook_cues(
    cues: Sequence[dict[str, Any]], *, fps: int, end_seconds: float
) -> list[dict[str, Any]]:
    end_frame = round(end_seconds * fps)
    return [
        cue
        for cue in cues
        if int(cue["start_frame"]) < end_frame and int(cue["end_frame"]) > 0
    ]


def prepare_translation_prepasses(
    *,
    settings: Settings,
    store: JobStore,
    job_id: str,
    workspace: Path,
    logger: logging.Logger,
) -> dict[str, Any] | None:
    cues = store.cues(job_id)
    if not cues:
        raise TranslationError("Cannot prepare translation context without cues")
    config = settings.section("translation")
    fps = int(settings.section("media")["target_fps"])
    translator = CodexTranslator(settings, workspace, logger)
    source_fingerprint = _cue_fingerprint(cues, fps=fps)
    bible_row = store.translation_prepass(job_id, "story-bible")
    story_bible: dict[str, Any] | None = None
    if _matching_prepass(
        bible_row,
        source_fingerprint=source_fingerprint,
        prompt_revision=STORY_BIBLE_PROMPT_REVISION,
        model=translator.model,
    ):
        if bible_row["status"] == "READY" and isinstance(bible_row["payload"], dict):
            story_bible = bible_row["payload"]
    else:
        duration = max(int(cue["end_frame"]) for cue in cues) / fps
        if (
            len(cues) <= int(config.get("story_bible_max_cues", 5000))
            and duration <= float(config.get("story_bible_max_seconds", 14400))
        ):
            for attempt in range(1, int(config.get("prepass_retry_attempts", 2)) + 2):
                try:
                    story_bible = translator.story_bible(cues, fps=fps)
                    store.set_translation_prepass(
                        job_id,
                        "story-bible",
                        source_fingerprint=source_fingerprint,
                        prompt_revision=STORY_BIBLE_PROMPT_REVISION,
                        model=translator.model,
                        status="READY",
                        payload=story_bible,
                    )
                    break
                except Exception as exc:
                    logger.warning("Story bible attempt %d failed: %s", attempt, exc)
        if story_bible is None:
            store.set_translation_prepass(
                job_id,
                "story-bible",
                source_fingerprint=source_fingerprint,
                prompt_revision=STORY_BIBLE_PROMPT_REVISION,
                model=translator.model,
                status="FALLBACK",
                payload={"reason": "unavailable"},
            )

    hook_end_seconds = round(float(config.get("hook_end_seconds", 8.0)), 3)
    hook_enabled = bool(config.get("hook_enabled", False))
    hook_fingerprint = config_fingerprint(
        {
            "cues": source_fingerprint,
            "story_bible": story_bible or {},
            "hook_end_seconds": hook_end_seconds,
            "hook_enabled": hook_enabled,
        }
    )
    hook_row = store.translation_prepass(job_id, "hook")
    if not _matching_prepass(
        hook_row,
        source_fingerprint=hook_fingerprint,
        prompt_revision=HOOK_PROMPT_REVISION,
        model=translator.model,
    ):
        store.clear_translations(job_id, _hook_replacement_ids(hook_row))
        hook_cues = _hook_cues(
            cues,
            fps=fps,
            end_seconds=hook_end_seconds,
        )
        payload: dict[str, Any] = {"mode": "original", "replacements": []}
        status = "ORIGINAL"
        if hook_enabled and story_bible is not None and hook_cues:
            for attempt in range(1, int(config.get("prepass_retry_attempts", 2)) + 2):
                try:
                    payload = translator.hook(cues, hook_cues, fps=fps, story_bible=story_bible)
                    status = "READY" if payload["mode"] == "replace" else "ORIGINAL"
                    break
                except Exception as exc:
                    logger.warning("Opening hook attempt %d failed: %s", attempt, exc)
        store.set_translation_prepass(
            job_id,
            "hook",
            source_fingerprint=hook_fingerprint,
            prompt_revision=HOOK_PROMPT_REVISION,
            model=translator.model,
            status=status,
            payload=payload,
        )
        hook_row = store.translation_prepass(job_id, "hook")
    if hook_row and hook_row["status"] == "READY":
        for replacement in hook_row["payload"].get("replacements", []):
            store.set_translation(job_id, int(replacement["id"]), str(replacement["text"]))
    return story_bible


def _skipped_translation_cues(row: dict[str, Any] | None) -> dict[int, str]:
    payload = row.get("payload") if row else None
    values = payload.get("skipped_cues") if isinstance(payload, dict) else None
    if not isinstance(values, list):
        return {}
    skipped: dict[int, str] = {}
    for value in values:
        if not isinstance(value, dict) or "id" not in value:
            continue
        try:
            skipped[int(value["id"])] = str(value.get("error") or "translation failed")
        except (TypeError, ValueError):
            continue
    return skipped


def skipped_translation_cue_indices(store: JobStore, job_id: str) -> set[int]:
    return set(_skipped_translation_cues(store.translation_prepass(job_id, "translation")))


def translation_cues_complete(store: JobStore, job_id: str) -> bool:
    cues = store.cues(job_id)
    if not cues:
        return False
    skipped = skipped_translation_cue_indices(store, job_id)
    return all(item.get("target_text") or int(item["cue_index"]) in skipped for item in cues)


def translation_prepasses_valid(
    *, settings: Settings, store: JobStore, job_id: str
) -> bool:
    cues = store.cues(job_id)
    if not cues:
        return False
    config = settings.section("translation")
    fps = int(settings.section("media")["target_fps"])
    source_fingerprint = _cue_fingerprint(cues, fps=fps)
    model = str(config.get("model") or "codex-config-default")
    translation_row = store.translation_prepass(job_id, "translation")
    if not _matching_prepass(
        translation_row,
        source_fingerprint=source_fingerprint,
        prompt_revision=PROMPT_REVISION,
        model=model,
    ) or translation_row["status"] != "READY":
        return False
    bible_row = store.translation_prepass(job_id, "story-bible")
    if not _matching_prepass(
        bible_row,
        source_fingerprint=source_fingerprint,
        prompt_revision=STORY_BIBLE_PROMPT_REVISION,
        model=model,
    ):
        return False
    story_bible = (
        bible_row["payload"]
        if bible_row["status"] == "READY" and isinstance(bible_row["payload"], dict)
        else None
    )
    hook_row = store.translation_prepass(job_id, "hook")
    return translation_cues_complete(store, job_id) and _matching_prepass(
        hook_row,
        source_fingerprint=config_fingerprint(
            {
                "cues": source_fingerprint,
                "story_bible": story_bible or {},
                "hook_end_seconds": round(float(config.get("hook_end_seconds", 8.0)), 3),
                "hook_enabled": bool(config.get("hook_enabled", False)),
            }
        ),
        prompt_revision=HOOK_PROMPT_REVISION,
        model=model,
    )


def translate_cues(
    *,
    settings: Settings,
    store: JobStore,
    job_id: str,
    workspace: Path,
    logger: logging.Logger,
    on_batch_complete: Callable[[], None] | None = None,
) -> list[dict[str, Any]]:
    cues = store.cues(job_id)
    fps = int(settings.section("media")["target_fps"])
    config = settings.section("translation")
    source_fingerprint = _cue_fingerprint(cues, fps=fps)
    model = str(config.get("model") or "codex-config-default")
    translation_row = store.translation_prepass(job_id, "translation")
    if not _matching_prepass(
        translation_row,
        source_fingerprint=source_fingerprint,
        prompt_revision=PROMPT_REVISION,
        model=model,
    ):
        store.clear_translations(job_id, [int(cue["cue_index"]) for cue in cues])
        store.invalidate_translation_outputs(job_id)
        store.set_translation_prepass(
            job_id,
            "translation",
            source_fingerprint=source_fingerprint,
            prompt_revision=PROMPT_REVISION,
            model=model,
            status="RUNNING",
            payload=None,
        )
        translation_row = None
    story_bible = prepare_translation_prepasses(
        settings=settings,
        store=store,
        job_id=job_id,
        workspace=workspace,
        logger=logger,
    )
    translator = CodexTranslator(settings, workspace, logger)
    batch_size = int(config["batch_size"])
    cues = store.cues(job_id)
    skipped_errors = _skipped_translation_cues(translation_row)
    pending = [
        item
        for item in cues
        if not item.get("target_text") and int(item["cue_index"]) not in skipped_errors
    ]
    positions = {int(item["cue_index"]): index for index, item in enumerate(cues)}
    context_window = max(
        0,
        int(settings.section("translation").get("context_window_cues", 12)),
    )
    for start in range(0, len(pending), batch_size):
        batch = pending[start : start + batch_size]
        if not batch:
            continue
        logger.info(
            "Translating cues %s-%s", batch[0]["cue_index"], batch[-1]["cue_index"]
        )
        first_position = positions[int(batch[0]["cue_index"])]
        last_position = positions[int(batch[-1]["cue_index"])]
        context_entries = cues[
            max(0, first_position - context_window) :
            min(len(cues), last_position + context_window + 1)
        ]
        batch_skipped: dict[int, str] = {}
        translated = translator.translate_entries(
            batch,
            context_entries=context_entries,
            story_bible=story_bible,
            skipped_errors=batch_skipped,
        )
        for cue_index, text in translated.items():
            store.set_translation(job_id, cue_index, text)
        skipped_errors.update(batch_skipped)
        if batch_skipped:
            limit = int(config.get("max_skipped_cues", 3))
            if len(skipped_errors) > limit:
                raise TranslationError(
                    f"Translation skipped {len(skipped_errors)} cue(s), above limit {limit}"
                )
        if on_batch_complete is not None:
            on_batch_complete()
    result = store.cues(job_id)
    missing = [
        int(item["cue_index"])
        for item in result
        if not item.get("target_text") and int(item["cue_index"]) not in skipped_errors
    ]
    if missing:
        raise TranslationError("Translation completed with missing cue text")
    store.set_translation_prepass(
        job_id,
        "translation",
        source_fingerprint=source_fingerprint,
        prompt_revision=PROMPT_REVISION,
        model=model,
        status="READY",
        payload=(
            {
                "skipped_cues": [
                    {"id": cue_index, "error": message}
                    for cue_index, message in sorted(skipped_errors.items())
                ]
            }
            if skipped_errors
            else None
        ),
    )
    return result


def shorten_tts_group(
    *,
    settings: Settings,
    store: JobStore,
    job_id: str,
    workspace: Path,
    logger: logging.Logger,
    cue_indices: Sequence[int],
    slot_seconds: float,
    required_speed: float,
    hard_speed: float,
    current_texts: dict[int, str] | None = None,
) -> dict[int, str]:
    cues = store.cues(job_id)
    positions = {int(item["cue_index"]): index for index, item in enumerate(cues)}
    selected = []
    for index in cue_indices:
        cue = dict(cues[positions[int(index)]])
        if current_texts and int(index) in current_texts:
            cue["target_text"] = current_texts[int(index)]
        selected.append(cue)
    context_window = max(
        0,
        int(settings.section("translation").get("context_window_cues", 12)),
    )
    first_position = positions[int(cue_indices[0])]
    last_position = positions[int(cue_indices[-1])]
    context_entries = cues[
        max(0, first_position - context_window) :
        min(len(cues), last_position + context_window + 1)
    ]
    translated = CodexTranslator(settings, workspace, logger).shorten_entries(
        selected,
        context_entries=context_entries,
        slot_seconds=slot_seconds,
        required_speed=required_speed,
        hard_speed=hard_speed,
    )
    return {int(cue_index): translated[int(cue_index)] for cue_index in cue_indices}
