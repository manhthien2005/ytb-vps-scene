from __future__ import annotations

import json
import unittest
from fractions import Fraction

from ytb_vps_v2.adapters.ocr.docker_detector import DockerOcrChunkDetector
from ytb_vps_v2.domain.models import BoundingBox
from ytb_vps_v2.ports.ocr import CoordinateTransform
from ytb_vps_v2.ports.pipeline import ProviderError


class DockerDetectorTests(unittest.TestCase):
    def test_shell_free_chunk_argv_and_jsonl_parity(self) -> None:
        seen = []

        def runner(argv, payload, timeout):
            seen.append((argv, payload, timeout))
            return 0, json.dumps(
                {"frame_index": 0, "box": [1, 2, 11, 12], "text": "字幕", "confidence": 0.9}
            ).encode() + b"\n"

        detector = DockerOcrChunkDetector("registry/ocr:cuda", runner=runner)
        payload = b"abc" * (20 * 20 * 2)
        result = detector.run_chunk(
            payload,
            width=20,
            height=20,
            start_frame=10,
            frame_step=2,
            expected_frames=2,
            transform=CoordinateTransform(),
        )
        argv, payload, timeout = seen[0]
        self.assertEqual(payload, b"abc" * (20 * 20 * 2))
        self.assertEqual(timeout, 300)
        self.assertEqual(argv[:5], ("docker", "run", "--rm", "--network", "none"))
        self.assertNotIn("sh", argv)
        self.assertEqual(result[0].frame_index, 10)
        self.assertEqual(result[0].box, BoundingBox(1, 2, 11, 12))

    def test_nonzero_or_oversized_output_fails(self) -> None:
        for runner in (
            lambda argv, payload, timeout: (1, b"failure"),
            lambda argv, payload, timeout: (0, b"x" * 10),
        ):
            with self.subTest(runner=runner), self.assertRaises(ProviderError):
                DockerOcrChunkDetector("ocr:latest", runner=runner, max_output_bytes=8).run_chunk(
                    b"abc", width=1, height=1, start_frame=0, frame_step=1,
                    expected_frames=1, transform=CoordinateTransform(),
                )

    def test_invalid_timeout_and_image_fail(self) -> None:
        with self.assertRaises(ProviderError):
            DockerOcrChunkDetector("ocr:latest", timeout_seconds=0)
        with self.assertRaises(ProviderError):
            DockerOcrChunkDetector("bad image")


if __name__ == "__main__":
    unittest.main()
