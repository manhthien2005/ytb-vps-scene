from __future__ import annotations

import argparse
import sys
from fractions import Fraction

from ytb_vps_v2.adapters.ocr.change_detection import ChangeDetectionPolicy
from ytb_vps_v2.adapters.ocr.onnx_detector import RapidOcrOnnxDetector
from ytb_vps_v2.adapters.ocr.worker_stdout import run_stdout_worker_loop


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--width", type=int, required=True)
    parser.add_argument("--height", type=int, required=True)
    parser.add_argument("--start-frame", type=int, required=True)
    parser.add_argument("--expected-frames", type=int, required=True)
    parser.add_argument("--frame-step", type=int, default=1)
    parser.add_argument("--frame-tolerance", type=int, default=1)
    parser.add_argument("--output", default="-")
    parser.add_argument("--minimum-confidence", default="0.55")
    parser.add_argument("--change-detection", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--change-threshold", default="8")
    parser.add_argument("--crop-min-y", default="0.5")
    parser.add_argument("--crop-max-y", default="0.98")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.output != "-":
        raise SystemExit("v2 OCR worker currently supports stdout only: use --output -")
    detector = RapidOcrOnnxDetector(
        width=args.width,
        height=args.height,
        crop_min_y=Fraction(args.crop_min_y),
        crop_max_y=Fraction(args.crop_max_y),
        minimum_confidence=Fraction(args.minimum_confidence),
    )
    policy = ChangeDetectionPolicy(
        enabled=args.change_detection,
        threshold=Fraction(args.change_threshold),
    )
    run_stdout_worker_loop(
        sys.stdin.buffer,
        sys.stdout,
        detector,
        width=args.width,
        height=args.height,
        channel_order="BGR",
        start_frame=args.start_frame,
        frame_step=args.frame_step,
        expected_frames=args.expected_frames,
        frame_tolerance=args.frame_tolerance,
        policy=policy,
        progress=lambda message: print(message, file=sys.stderr, flush=True),
    )


if __name__ == "__main__":
    main()
