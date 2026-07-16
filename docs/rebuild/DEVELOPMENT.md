# V2 Development

V2 targets Python 3.10 in production and CI. The current Windows development
host may use Python 3.12 for fast local feedback because the package declares
support for Python `>=3.10,<3.13`.

## Install

From the repository root:

```powershell
python -m pip install --no-deps --no-build-isolation -e .
```

## Verify

```powershell
$env:PYTHONPATH = 'src'
python -m compileall -q src tests_v2
python -m unittest discover -s tests_v2 -t . -v
ytb-vps-v2 version
```

The public `ytb-vps` command remains legacy until the dedicated cutover commit.
Use only `ytb-vps-v2` for v2 development before cutover.
