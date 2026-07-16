from __future__ import annotations

import logging
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.support import test_settings
from ytb_vps.media import run_ffmpeg
from ytb_vps.pipeline import (
    VideoPipeline,
    part_filename,
    plan_publish_parts,
    publish_part_count,
)
from ytb_vps.queue import build_job_identity
from ytb_vps.state import JobStore
from ytb_vps.tts import group_cues
from ytb_vps.util import config_fingerprint, sha256_file


class PipelineResumeTests(unittest.TestCase):
    def test_publish_part_count_matches_duration_rules(self) -> None:
        self.assertEqual(publish_part_count(59 * 60 + 59), 1)
        self.assertEqual(publish_part_count(60 * 60), 2)
        self.assertEqual(publish_part_count(89 * 60 + 59), 2)
        self.assertEqual(publish_part_count(90 * 60), 3)
        self.assertEqual(publish_part_count(119 * 60 + 59), 3)
        self.assertEqual(publish_part_count(120 * 60), 4)

    def test_publish_parts_follow_render_chunk_boundaries(self) -> None:
        chunks = [
            {
                "chunk_index": index,
                "start_seconds": index * 120.0,
                "end_seconds": (index + 1) * 120.0,
            }
            for index in range(100)
        ]
        parts = plan_publish_parts(chunks, 12_000.0)
        self.assertEqual(len(parts), 6)
        self.assertEqual([part[0]["chunk_index"] for part in parts], [0, 17, 33, 50, 67, 83])
        self.assertEqual([part[-1]["chunk_index"] for part in parts], [16, 32, 49, 66, 82, 99])

    def test_publish_retries_only_missing_part(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root)
            source = settings.data_path("input") / "source.mp4"
            source.write_bytes(b"source")
            workspace = settings.data_path("work") / "job"
            output = settings.data_path("output") / "folder"
            media = {
                "duration_seconds": 7_200.0,
                "width": 320,
                "height": 180,
                "fps": 30.0,
                "has_audio": True,
            }
            chunks = []
            for index in range(4):
                artifact = workspace / "render" / f"chunk_{index:02d}.mp4"
                artifact.parent.mkdir(parents=True, exist_ok=True)
                run_ffmpeg(
                    [
                        "-y",
                        "-f",
                        "lavfi",
                        "-i",
                        "testsrc=size=320x180:rate=30:duration=1",
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
                        "-shortest",
                        str(artifact),
                    ],
                    duration_seconds=1,
                )
                chunks.append(
                    {
                        "index": index,
                        "start_frame": index * 54_000,
                        "end_frame": (index + 1) * 54_000,
                        "start_seconds": index * 1_800.0,
                        "end_seconds": (index + 1) * 1_800.0,
                        "artifact": artifact,
                    }
                )
            with JobStore(workspace / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=source,
                    source_signature="source",
                    output_path=output,
                    config_signature="cfg",
                )
                store.set_media("job", media)
                store.plan_chunks("job", "render", chunks)
                for chunk in chunks:
                    store.complete_chunk(
                        "job",
                        "render",
                        chunk["index"],
                        artifact_path=chunk["artifact"],
                        checksum=sha256_file(chunk["artifact"]),
                    )
                pipeline = VideoPipeline(
                    settings=settings,
                    store=store,
                    job_id="job",
                    input_path=source,
                    workspace=workspace,
                    output_path=output,
                    logger=logging.getLogger("pipeline-test"),
                )
                with patch(
                    "ytb_vps.pipeline.validate_final",
                    side_effect=lambda path, *_args, **_kwargs: {
                        "full_decode": True,
                        "checksum": sha256_file(path),
                    },
                ):
                    pipeline._publish()
                    first = output / part_filename(1, 4)
                    second = output / part_filename(4, 4)
                    first_checksum = sha256_file(first)
                    second.unlink()
                    second.with_suffix(".validation.json").unlink()
                    pipeline._publish()

                self.assertEqual(sha256_file(first), first_checksum)
                self.assertTrue(second.is_file())
                self.assertTrue(second.with_suffix(".validation.json").is_file())

    def test_backup_uploads_parts_into_output_folder(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root, drive={"enabled": True})
            source = settings.data_path("input") / "source.mp4"
            source.write_bytes(b"source")
            workspace = settings.data_path("work") / "job"
            output = settings.data_path("output") / "source-12345678"
            output.mkdir(parents=True)
            part = output / part_filename(1, 1)
            validation = part.with_suffix(".validation.json")
            manifest = output / "publish-manifest.json"
            part.write_bytes(b"part")
            validation.write_text("{}", encoding="utf-8")
            manifest.write_text("{}", encoding="utf-8")
            with JobStore(workspace / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=source,
                    source_signature="source",
                    output_path=output,
                    config_signature="cfg",
                )
                for name, path in (
                    ("part-01-output", part),
                    ("part-01-validation", validation),
                    ("publish-manifest", manifest),
                ):
                    store.record_artifact("job", name, path, sha256_file(path))
                pipeline = VideoPipeline(
                    settings=settings,
                    store=store,
                    job_id="job",
                    input_path=source,
                    workspace=workspace,
                    output_path=output,
                    logger=logging.getLogger("pipeline-test"),
                )
                with patch(
                    "ytb_vps.pipeline.backup_output",
                    side_effect=lambda _settings, path, *, remote_path: remote_path,
                ) as backup:
                    pipeline._backup()

                self.assertEqual(
                    [call.kwargs["remote_path"] for call in backup.call_args_list],
                    [
                        f"gdrive:YTB-VPS/output/{output.name}/{part.name}",
                        f"gdrive:YTB-VPS/output/{output.name}/{validation.name}",
                        f"gdrive:YTB-VPS/output/{output.name}/{manifest.name}",
                    ],
                )

    def test_publish_uploads_each_part_then_removes_local_media(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root, drive={"enabled": True})
            source = settings.data_path("input") / "source.mp4"
            source.write_bytes(b"source")
            workspace = settings.data_path("work") / "job"
            output = settings.data_path("output") / "remote-output"
            media = {
                "duration_seconds": 7_200.0,
                "width": 320,
                "height": 180,
                "fps": 30.0,
                "has_audio": True,
            }
            chunks = []
            for index in range(4):
                artifact = workspace / "render" / "chunks" / f"chunk_{index:06d}.mp4"
                artifact.parent.mkdir(parents=True, exist_ok=True)
                run_ffmpeg(
                    [
                        "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=1",
                        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "1",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                        "-shortest", str(artifact),
                    ],
                    duration_seconds=1,
                )
                chunks.append(
                    {
                        "index": index,
                        "start_frame": index * 54_000,
                        "end_frame": (index + 1) * 54_000,
                        "start_seconds": index * 1_800.0,
                        "end_seconds": (index + 1) * 1_800.0,
                        "artifact": artifact,
                    }
                )
            with JobStore(workspace / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job", input_path=source, source_signature="source",
                    output_path=output, config_signature="cfg",
                )
                store.set_media("job", media)
                store.plan_chunks("job", "render", chunks)
                for chunk in chunks:
                    store.complete_chunk(
                        "job", "render", chunk["index"],
                        artifact_path=chunk["artifact"], checksum=sha256_file(chunk["artifact"]),
                    )
                pipeline = VideoPipeline(
                    settings=settings, store=store, job_id="job", input_path=source,
                    workspace=workspace, output_path=output,
                    logger=logging.getLogger("pipeline-test"),
                )
                with patch(
                    "ytb_vps.pipeline.validate_final",
                    side_effect=lambda path, *_args, **_kwargs: {
                        "full_decode": True, "checksum": sha256_file(path),
                    },
                ), patch(
                    "ytb_vps.pipeline.backup_output",
                    side_effect=lambda _settings, _path, *, remote_path: remote_path,
                ) as backup:
                    pipeline._publish()

                self.assertEqual(backup.call_count, 9)
                self.assertTrue(pipeline._publish_valid())
                self.assertTrue(pipeline._render_valid())
                self.assertEqual(list(output.glob("*.mp4")), [])
                self.assertEqual(
                    [path.name for path in output.iterdir()], ["publish-manifest.json"]
                )
                self.assertFalse(any(workspace.glob("render/chunks/*.mp4")))
                self.assertFalse(any((workspace / "publish").iterdir()))

    def test_pipeline_publishes_and_reuses_completed_units(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(
                root,
                render={"preset": "ultrafast", "crf": 30, "font_size": 18, "outline": 2},
            )
            source = settings.data_path("input") / "source.mp4"
            run_ffmpeg(
                [
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=size=320x180:rate=30:duration=2",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=300:sample_rate=44100:duration=2",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-shortest",
                    str(source),
                ],
                duration_seconds=2,
            )
            job_id, signature = build_job_identity(source)
            workspace = settings.data_path("work") / job_id
            output = settings.data_path("output") / "final-output"
            counters = {"ocr": 0, "translate": 0, "tts": 0}

            def fake_ocr(**kwargs):
                counters["ocr"] += 1
                chunk = kwargs["chunk"]
                index = int(chunk["chunk_index"])
                artifact = workspace / "ocr" / "chunks" / f"chunk_{index:06d}.jsonl"
                artifact.parent.mkdir(parents=True, exist_ok=True)
                detections = [
                    {"frame_index": frame, "line_index": 0, "box": [80, 130, 240, 165], "text": "你好", "confidence": 0.99}
                    for frame in range(5, 51)
                ]
                artifact.write_text("\n".join("{}" for _ in detections) + "\n", encoding="utf-8")
                kwargs["store"].replace_chunk_detections(job_id, index, detections)
                return {"path": artifact, "checksum": sha256_file(artifact), "frames": 60, "detections": len(detections)}

            def fake_translate(**kwargs):
                counters["translate"] += 1
                store = kwargs["store"]
                for cue in store.cues(job_id):
                    store.set_translation(job_id, int(cue["cue_index"]), "Xin chào")
                return store.cues(job_id)

            def fake_tts(**kwargs):
                counters["tts"] += 1
                store = kwargs["store"]
                fps = 30
                groups = group_cues(
                    store.cues(job_id),
                    fps,
                    settings.section("tts"),
                    chunk_end_frames=[int(item["end_frame"]) for item in store.chunks(job_id, "render")],
                )
                store.plan_tts_groups(job_id, groups, settings.section("tts"))
                for group in groups:
                    raw = workspace / "tts" / "raw" / f"{group.index}.mp3"
                    fitted = workspace / "tts" / "fitted" / f"{group.index}.wav"
                    raw.parent.mkdir(parents=True, exist_ok=True)
                    fitted.parent.mkdir(parents=True, exist_ok=True)
                    raw.write_bytes(b"test")
                    duration = group.end - group.start
                    run_ffmpeg(
                        [
                            "-y",
                            "-f",
                            "lavfi",
                            "-i",
                            "anullsrc=r=44100:cl=stereo",
                            "-t",
                            f"{duration:.6f}",
                            str(fitted),
                        ],
                        duration_seconds=duration,
                    )
                    store.complete_tts_group(
                        job_id,
                        group.index,
                        raw=raw,
                        fitted=fitted,
                        checksum=sha256_file(fitted),
                        metadata={"fake": True},
                    )
                return store.tts_groups(job_id)

            with JobStore(workspace / "job.sqlite") as store:
                store.initialize_job(
                    job_id=job_id,
                    input_path=source,
                    source_signature=signature,
                    output_path=output,
                    config_signature=config_fingerprint(settings.raw),
                )
                pipeline = VideoPipeline(
                    settings=settings,
                    store=store,
                    job_id=job_id,
                    input_path=source,
                    workspace=workspace,
                    output_path=output,
                    logger=logging.getLogger("pipeline-test"),
                )
                with patch("ytb_vps.pipeline.run_ocr_chunk", side_effect=fake_ocr), patch(
                    "ytb_vps.pipeline.translate_cues", side_effect=fake_translate
                ), patch("ytb_vps.pipeline.synthesize_groups", side_effect=fake_tts):
                    pipeline.run()
                    pipeline.run()

                self.assertEqual(store.job(job_id)["status"], "DONE")
                self.assertEqual(counters, {"ocr": 1, "translate": 1, "tts": 1})
                self.assertTrue((output / part_filename(1, 1)).is_file())
                self.assertTrue(
                    (output / part_filename(1, 1)).with_suffix(".validation.json").is_file()
                )
                self.assertEqual(store.stage_status(job_id, "DONE"), "DONE")


if __name__ == "__main__":
    unittest.main()
