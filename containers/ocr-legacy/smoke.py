from __future__ import annotations

import json

import paddle


def main() -> None:
    compiled = bool(paddle.device.is_compiled_with_cuda())
    device_count = int(paddle.device.cuda.device_count()) if compiled else 0
    report = {
        "paddle": paddle.__version__,
        "compiled_with_cuda": compiled,
        "cuda_devices": device_count,
    }
    print(json.dumps(report, sort_keys=True))
    if not compiled or device_count < 1:
        raise SystemExit(2)


if __name__ == "__main__":
    main()

