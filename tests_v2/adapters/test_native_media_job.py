from __future__ import annotations

import copy
import subprocess
import tempfile
import unittest
from array import array
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from tests_v2.support.fixtures import build_fixture, ffmpeg_available
from ytb_vps_v2.adapters import native_media_job
from ytb_vps_v2.adapters.native_media_job import (
    canonicalize_source,
    run_native_pipeline,
)
from ytb_vps_v2.adapters.offline.providers import DeterministicWaveTtsProvider
from ytb_vps_v2.adapters.sqlite.state import SqliteStateStore
from ytb_vps_v2.application.media_job import MediaJobError, scene_blur_regions
from ytb_vps_v2.domain.config import EffectiveConfig
from ytb_vps_v2.domain.fingerprints import stage_config_fingerprints
from ytb_vps_v2.domain.models import JobId, StageName, WorkStatus
from ytb_vps_v2.domain.timeline import FrameInterval


def duration(path: Path) -> float:
    raw = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
            str(path),
        ],
        capture_output=True,
        check=True,
        text=True,
    ).stdout.strip()
    return float(raw)


V3_SETTINGS = {
    "version": 3,
    "regions": [
        {
            "id": "a",
            "kind": "blur",
            "label": "sub gốc",
            "enabled": True,
            "rectangle": {
                "x": 0.0,
                "y": 0.8,
                "width": 1.0,
                "height": 0.15,
            },
            "timeRanges": None,
            "origin": "manual",
            "strength": None,
        },
        {
            "id": "b",
            "kind": "channelLogo",
            "label": "logo",
            "enabled": True,
            "rectangle": {
                "x": 0.83,
                "y": 0.02,
                "width": 0.15,
                "height": 0.09,
            },
            "timeRanges": None,
            "origin": "auto",
            "strength": None,
        },
        {
            "id": "c",
            "kind": "blur",
            "label": "tắt",
            "enabled": False,
            "rectangle": {
                "x": 0.1,
                "y": 0.1,
                "width": 0.1,
                "height": 0.1,
            },
            "timeRanges": None,
            "origin": "manual",
            "strength": None,
        },
        {
            "id": "d",
            "kind": "subtitle",
            "label": "vị trí sub",
            "enabled": True,
            "rectangle": {
                "x": 0.05,
                "y": 0.78,
                "width": 0.9,
                "height": 0.16,
            },
            "timeRanges": None,
            "origin": "manual",
            "strength": None,
        },
    ],
}


class SceneRegionTests(unittest.TestCase):
    def test_disabled_regions_are_dropped(self) -> None:
        regions = scene_blur_regions(
            V3_SETTINGS,
            1280,
            720,
            frame_count=900,
        )
        self.assertEqual(len(regions), 2)

    def test_subtitle_placement_is_not_a_mask(self) -> None:
        regions = scene_blur_regions(
            V3_SETTINGS,
            1280,
            720,
            frame_count=900,
        )
        for region in regions:
            self.assertNotEqual(region.box.ymin, int(0.78 * 720))

    def test_ratios_map_onto_canvas_pixels(self) -> None:
        regions = scene_blur_regions(
            V3_SETTINGS,
            1280,
            720,
            frame_count=900,
        )
        band = min(regions, key=lambda item: item.box.xmin)
        self.assertEqual(band.box.xmin, 0)
        self.assertEqual(band.box.xmax, 1280)

    def test_regions_cover_the_whole_timeline_by_default(self) -> None:
        for region in scene_blur_regions(
            V3_SETTINGS,
            1280,
            720,
            frame_count=900,
        ):
            self.assertEqual(region.interval.start_frame, 0)
            self.assertEqual(region.interval.end_frame, 900)

    def test_legacy_version_two_settings_still_load(self) -> None:
        legacy = {
            "version": 2,
            "blur": {
                "mode": "manual",
                "regions": [
                    {
                        "kind": "sourceSubtitle",
                        "enabled": True,
                        "rectangle": {
                            "x": 0.05,
                            "y": 0.78,
                            "width": 0.9,
                            "height": 0.16,
                        },
                    },
                    {
                        "kind": "logo",
                        "enabled": True,
                        "rectangle": {
                            "x": 0.78,
                            "y": 0.04,
                            "width": 0.18,
                            "height": 0.16,
                        },
                    },
                ],
            },
            "sourceSubtitle": {
                "x": 0.05,
                "y": 0.78,
                "width": 0.9,
                "height": 0.16,
            },
            "logo": {
                "x": 0.78,
                "y": 0.04,
                "width": 0.18,
                "height": 0.16,
            },
        }
        self.assertEqual(
            len(
                scene_blur_regions(
                    legacy,
                    1280,
                    720,
                    frame_count=900,
                )
            ),
            2,
        )

    def test_time_ranges_become_separate_frame_intervals(self) -> None:
        settings = copy.deepcopy(V3_SETTINGS)
        settings["regions"][0]["timeRanges"] = [
            {"startSeconds": 0.5, "endSeconds": 1.0},
            {"startSeconds": 2.0, "endSeconds": 2.5},
        ]
        settings["regions"][1]["enabled"] = False

        regions = scene_blur_regions(
            settings,
            1280,
            720,
            frame_count=90,
        )

        self.assertEqual(
            tuple(region.interval for region in regions),
            (FrameInterval(15, 30), FrameInterval(60, 75)),
        )

    def test_empty_time_ranges_do_not_turn_into_a_permanent_mask(self) -> None:
        settings = copy.deepcopy(V3_SETTINGS)
        settings["regions"][0]["timeRanges"] = []
        settings["regions"][1]["enabled"] = False

        self.assertEqual(
            scene_blur_regions(
                settings,
                1280,
                720,
                frame_count=90,
            ),
            (),
        )

    def test_time_ranges_must_stay_inside_the_media_timeline(self) -> None:
        settings = copy.deepcopy(V3_SETTINGS)
        settings["regions"][0]["timeRanges"] = [
            {"startSeconds": 2.5, "endSeconds": 3.5},
        ]

        with self.assertRaisesRegex(MediaJobError, "time range"):
            scene_blur_regions(
                settings,
                1280,
                720,
                frame_count=90,
            )


class NativePipelineConfigurationTests(unittest.TestCase):
    def test_runner_passes_scene_identity_and_default_chunk_size(self) -> None:
        captured = []

        def capture_run(_runner: object, request: object) -> object:
            captured.append(request)
            return SimpleNamespace(workspace_root=request.workspace_root)

        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            source = root_path / "source.mp4"
            source.write_bytes(b"source")
            settings = copy.deepcopy(V3_SETTINGS)
            settings["voice"] = "vi-VN-HoaiMyNeural"
            settings["rate"] = 1.1
            with (
                mock.patch.object(
                    native_media_job,
                    "canonicalize_source",
                    return_value=(
                        source,
                        SimpleNamespace(
                            width=320,
                            height=180,
                            frame_count=360,
                        ),
                    ),
                ),
                mock.patch.object(
                    native_media_job.OfflineSliceRunner,
                    "run",
                    autospec=True,
                    side_effect=capture_run,
                ),
                mock.patch.object(native_media_job, "CapCutTtsProvider"),
            ):
                run_native_pipeline(
                    source,
                    root_path / "workspace-a",
                    settings,
                    "native-config-a",
                )

                changed = copy.deepcopy(settings)
                changed["regions"][0]["rectangle"]["width"] = 0.9
                run_native_pipeline(
                    source,
                    root_path / "workspace-b",
                    changed,
                    "native-config-b",
                )

        before, after = captured
        self.assertEqual(before.chunk_seconds, 300)
        default_fingerprints = {
            item.stage: item.fingerprint
            for item in stage_config_fingerprints(EffectiveConfig())
        }
        actual_fingerprints = {
            item.stage: item.fingerprint
            for item in before.config_fingerprints
        }
        self.assertEqual(
            actual_fingerprints[StageName.OCR],
            default_fingerprints[StageName.OCR],
        )
        self.assertEqual(
            actual_fingerprints[StageName.TRANSLATE],
            default_fingerprints[StageName.TRANSLATE],
        )
        self.assertNotEqual(
            actual_fingerprints[StageName.TTS],
            default_fingerprints[StageName.TTS],
        )
        self.assertEqual(
            tuple(
                old.stage
                for old, new in zip(
                    before.config_fingerprints,
                    after.config_fingerprints,
                    strict=True,
                )
                if old.fingerprint != new.fingerprint
            ),
            (StageName.RENDER,),
        )


@unittest.skipUnless(ffmpeg_available(), "ffmpeg required")
class CanonicalizeSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def make_long_source(self) -> Path:
        destination = self.root / "long-source.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=160x90:rate=30:duration=32",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-an",
                str(destination),
            ],
            check=True,
            capture_output=True,
            timeout=120,
        )
        return destination

    def test_source_is_no_longer_truncated_to_thirty_seconds(self) -> None:
        source = self.make_long_source()
        canonical, document = canonicalize_source(self.root / "work", source)
        self.assertAlmostEqual(duration(canonical), duration(source), delta=0.2)
        self.assertGreater(duration(canonical), 30.5)
        self.assertEqual(document.frame_count, round(duration(source) * 30))

    def test_cover_art_source_is_accepted(self) -> None:
        source = build_fixture("cover_art", self.root)
        canonical, _ = canonicalize_source(self.root / "work", source)
        self.assertTrue(canonical.is_file())


@unittest.skipUnless(ffmpeg_available(), "ffmpeg required")
class NativePipelineEndToEndTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                (
                    "testsrc2=size=320x180:rate=30:duration=12,"
                    "noise=alls=40:allf=t+u"
                ),
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=12",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                str(self.source),
            ],
            check=True,
            capture_output=True,
            timeout=180,
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def audio_energy(
        video: Path,
        windows: tuple[tuple[int, int], ...],
    ) -> tuple[float, ...]:
        raw = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(video),
                "-map",
                "0:a",
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ac",
                "1",
                "-ar",
                "48000",
                "-",
            ],
            capture_output=True,
            check=True,
            timeout=300,
        ).stdout
        samples = array("h")
        samples.frombytes(raw[: len(raw) - len(raw) % 2])
        energies = []
        for start, end in windows:
            chunk = samples[start * 48_000:end * 48_000]
            total_square = sum((value / 32768.0) ** 2 for value in chunk)
            energies.append((total_square / len(chunk)) ** 0.5)
        return tuple(energies)

    @staticmethod
    def horizontal_detail(
        video: Path,
        *,
        at_seconds: float,
        crop_filter: str,
        width: int,
    ) -> float:
        raw = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                str(at_seconds),
                "-i",
                str(video),
                "-frames:v",
                "1",
                "-vf",
                f"{crop_filter},format=gray",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "gray",
                "-",
            ],
            check=True,
            capture_output=True,
            timeout=120,
        ).stdout
        differences = []
        for row_start in range(0, len(raw), width):
            row = raw[row_start:row_start + width]
            differences.extend(
                abs(row[index] - row[index - 1])
                for index in range(1, len(row))
            )
        return sum(differences) / len(differences)

    def test_native_pipeline_keeps_timeline_audio_and_timed_masks(self) -> None:
        default = EffectiveConfig()
        config = replace(
            default,
            media=replace(default.media, chunk_seconds=4),
        )
        settings = copy.deepcopy(V3_SETTINGS)
        settings["regions"][0]["rectangle"] = {
            "x": 0.0,
            "y": 0.3,
            "width": 1.0,
            "height": 0.2,
        }
        settings["regions"][0]["timeRanges"] = [
            {"startSeconds": 3.0, "endSeconds": 8.0}
        ]
        settings["rate"] = 1.0

        with mock.patch.object(
            native_media_job,
            "CapCutTtsProvider",
            return_value=DeterministicWaveTtsProvider(),
        ):
            output = run_native_pipeline(
                self.source,
                self.root / "workspace",
                settings,
                "native-e2e",
                config=config,
            )

        self.assertTrue(output.is_file())
        self.assertAlmostEqual(
            duration(output),
            duration(self.source),
            delta=1 / 30,
        )
        for energy in self.audio_energy(
            output,
            ((0, 4), (4, 8), (8, 12)),
        ):
            self.assertGreater(energy, 0.005)
        source_during = self.horizontal_detail(
            self.source,
            at_seconds=4.0,
            crop_filter="crop=320:36:0:54",
            width=320,
        )
        source_after = self.horizontal_detail(
            self.source,
            at_seconds=10.0,
            crop_filter="crop=320:36:0:54",
            width=320,
        )
        output_during = self.horizontal_detail(
            output,
            at_seconds=4.0,
            crop_filter="crop=320:36:0:54",
            width=320,
        )
        output_after = self.horizontal_detail(
            output,
            at_seconds=10.0,
            crop_filter="crop=320:36:0:54",
            width=320,
        )
        retained_during = output_during / source_during
        retained_after = output_after / source_after
        self.assertGreater(retained_after, retained_during * 2)
        state = SqliteStateStore(
            self.root / "workspace" / "state" / "job-v2.sqlite"
        )
        try:
            chunks = tuple(
                unit
                for unit in state.work_units(JobId("native-e2e"))
                if unit.key.startswith("render:")
                and unit.key != "render:plan"
            )
        finally:
            state.close()
        self.assertEqual(
            tuple(unit.key for unit in chunks),
            ("render:000000", "render:000001", "render:000002"),
        )
        self.assertTrue(
            all(unit.status is WorkStatus.SUCCEEDED for unit in chunks)
        )
        for index in range(3):
            self.assertTrue(
                (
                    self.root
                    / "workspace"
                    / "pipeline"
                    / "artifacts"
                    / "render"
                    / "chunks"
                    / f"chunk-{index:06d}.mp4"
                ).is_file()
            )
