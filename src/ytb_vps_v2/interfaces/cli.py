from __future__ import annotations

import argparse
from collections.abc import Sequence

from ytb_vps_v2 import __version__


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ytb-vps-v2")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version", help="print the v2 development version")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    if arguments.command == "version":
        print(f"ytb-vps-v2 {__version__}")
        return 0
    raise AssertionError(f"Unhandled command: {arguments.command}")
