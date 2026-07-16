from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.support import test_settings
from ytb_vps.scene_voiceover import build_scenes
from ytb_vps.state import JobStore


def cue(index: int, start: int, end: int, text: str) -> dict:
    return {
        "cue_index": index,
        "start_frame": start,
        "end_frame": end,
        "xmin": 100,
        "ymin": 500,
        "xmax": 400,
        "ymax": 560,
        "source_text": text,
        "source_hash": f"cue-{index}",
    }


class SceneVoiceoverTests(unittest.TestCase):
    def test_split_uses_gap_duration_and_source_cap(self) -> None:
        config = {
            "scene_gap_seconds": 1.0,
            "scene_max_seconds": 3.0,
            "scene_max_source_chars": 4,
        }
        scenes = build_scenes(
            [cue(1, 0, 30, "aa"), cue(2, 31, 60, "bb"), cue(3, 100, 130, "cc")],
            fps=30,
            config=config,
        )
        self.assertEqual([scene["cue_indices"] for scene in scenes], [[1, 2], [3]])

    def test_scene_checkpoint_survives_identical_replan(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = test_settings(root)
            scene = build_scenes([cue(1, 0, 30, "source")], fps=30, config={})[0]
            with JobStore(root / "job.sqlite") as store:
                store.initialize_job(
                    job_id="job",
                    input_path=root / "input.mp4",
                    source_signature="source",
                    output_path=root / "output.mp4",
                    config_signature="config",
                    pipeline_mode="scene_voiceover",
                )
                store.replace_scenes("job", [scene])
                store.complete_scene("job", 0, summary="summary", narration="narration")
                store.replace_scenes("job", [scene])
                self.assertEqual(store.scenes("job")[0]["status"], "DONE")
                self.assertEqual(store.voiceover_segments("job")[0]["text"], "narration")
                self.assertEqual(store.pipeline_mode("job"), "scene_voiceover")


if __name__ == "__main__":
    unittest.main()
