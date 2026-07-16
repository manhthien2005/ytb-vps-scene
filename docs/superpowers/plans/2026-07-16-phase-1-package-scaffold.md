# Phase 1 Package Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create an independently installable v2 Python package, development CLI, Python 3.10 CI gate, and local developer instructions without changing the legacy runtime or public `ytb-vps` entry point.

**Architecture:** Establish the `src/ytb_vps_v2/` package boundary and expose only a temporary `ytb-vps-v2` development command. Use standard-library `unittest` so the first slice has no runtime dependency and can run on the current Python 3.12 host while CI proves Python 3.10 compatibility.

**Tech Stack:** Python 3.10–3.12, setuptools, argparse, unittest, GitHub Actions.

## Global Constraints

- Work on branch `rebuild/v2`; do not create or switch to another product branch.
- Keep `app/ytb_vps/` and the public `ytb-vps` entry point unchanged.
- V2 code lives under `src/ytb_vps_v2/` and must not import `app/ytb_vps/`.
- Production target is Python 3.10; local development also supports the installed Python 3.12.10 host.
- Do not add credentials, runtime data, output media, models, caches, or vendor artifacts.
- Use test-first development and one-purpose Conventional Commits.
- Before every commit, run `git diff --check`, review the full diff, and inspect staged filenames.
- Do not push.

## File map

- `pyproject.toml`: v2 build metadata, supported Python range, source layout, and temporary development script.
- `src/ytb_vps_v2/__init__.py`: package version and public package marker only.
- `src/ytb_vps_v2/__main__.py`: `python -m ytb_vps_v2` adapter.
- `src/ytb_vps_v2/interfaces/__init__.py`: interface package marker.
- `src/ytb_vps_v2/interfaces/cli.py`: minimal development CLI parser and version command.
- `tests_v2/__init__.py`: isolated v2 unittest discovery root.
- `tests_v2/test_package_smoke.py`: packaging, source-boundary, and import tests.
- `tests_v2/test_cli.py`: development CLI unit and module-entry tests.
- `tests_v2/test_ci_contract.py`: static CI contract test.
- `.github/workflows/v2-ci.yml`: Python 3.10 clean install, compile, and v2 suite.
- `docs/rebuild/DEVELOPMENT.md`: exact local Phase 1 setup and verification commands.
- `docs/rebuild/AUDIT-LOG.md`: completed Phase 1 evidence after all implementation commits.

---

### Task 1: Independent package metadata and import boundary

**Files:**
- Create: `pyproject.toml`
- Create: `src/ytb_vps_v2/__init__.py`
- Create: `tests_v2/__init__.py`
- Create: `tests_v2/test_package_smoke.py`

**Interfaces:**
- Consumes: no v2 interfaces.
- Produces: `ytb_vps_v2.__version__: str` with value `0.1.0.dev0`; setuptools package discovery rooted at `src`; temporary console target `ytb-vps-v2 = ytb_vps_v2.interfaces.cli:main`.

- [ ] **Step 1: Write the failing package smoke tests**

Create `tests_v2/__init__.py` as an empty file and create
`tests_v2/test_package_smoke.py` with:

```python
from __future__ import annotations

import importlib
import sys
import unittest
from pathlib import Path


class PackageSmokeTests(unittest.TestCase):
    def test_package_import_is_independent_from_legacy(self) -> None:
        sys.modules.pop("ytb_vps_v2", None)
        module = importlib.import_module("ytb_vps_v2")

        self.assertEqual(module.__version__, "0.1.0.dev0")
        self.assertNotIn("ytb_vps", sys.modules)

    def test_project_metadata_uses_src_layout_and_dev_entry_point(self) -> None:
        metadata = Path("pyproject.toml").read_text(encoding="utf-8")

        self.assertIn('requires-python = ">=3.10,<3.13"', metadata)
        self.assertIn(
            'ytb-vps-v2 = "ytb_vps_v2.interfaces.cli:main"',
            metadata,
        )
        self.assertNotIn('\nytb-vps = "', metadata)
        self.assertIn('package-dir = {"" = "src"}', metadata)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to prove the package is absent**

Run in PowerShell:

```powershell
$env:PYTHONPATH = 'src'
python -m unittest tests_v2.test_package_smoke -v
```

Expected: error with `ModuleNotFoundError: No module named 'ytb_vps_v2'` or failure because `pyproject.toml` does not exist.

- [ ] **Step 3: Add minimal build metadata and package marker**

Create `pyproject.toml` with:

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "ytb-vps-scene-v2"
version = "0.1.0.dev0"
description = "Resumable VPS video localization pipeline v2"
requires-python = ">=3.10,<3.13"
dependencies = []

[project.scripts]
ytb-vps-v2 = "ytb_vps_v2.interfaces.cli:main"

[tool.setuptools]
package-dir = {"" = "src"}

[tool.setuptools.packages.find]
where = ["src"]
include = ["ytb_vps_v2*"]
```

Create `src/ytb_vps_v2/__init__.py` with:

```python
"""Independent v2 implementation for the YTB VPS pipeline."""

__version__ = "0.1.0.dev0"
```

- [ ] **Step 4: Run the focused package tests**

Run:

```powershell
$env:PYTHONPATH = 'src'
python -m unittest tests_v2.test_package_smoke -v
```

Expected: 2 tests pass.

- [ ] **Step 5: Verify editable package installation on the local host**

Run:

```powershell
python -m pip install --no-deps --no-build-isolation -e .
python -c "import ytb_vps_v2; print(ytb_vps_v2.__version__)"
```

Expected: installation succeeds and prints `0.1.0.dev0`.

- [ ] **Step 6: Review and commit Task 1**

Run:

```powershell
git diff --check
git diff -- pyproject.toml src/ytb_vps_v2/__init__.py tests_v2/__init__.py tests_v2/test_package_smoke.py
git add -- pyproject.toml src/ytb_vps_v2/__init__.py tests_v2/__init__.py tests_v2/test_package_smoke.py
git diff --cached --name-status
git commit -m "build(v2): scaffold independent package"
```

Expected: one non-empty commit containing only the four Task 1 files.

### Task 2: Development CLI without legacy cutover

**Files:**
- Create: `src/ytb_vps_v2/interfaces/__init__.py`
- Create: `src/ytb_vps_v2/interfaces/cli.py`
- Create: `src/ytb_vps_v2/__main__.py`
- Create: `tests_v2/test_cli.py`

**Interfaces:**
- Consumes: `ytb_vps_v2.__version__: str`.
- Produces: `build_parser() -> argparse.ArgumentParser`; `main(argv: Sequence[str] | None = None) -> int`; `python -m ytb_vps_v2 version`; installed `ytb-vps-v2 version`.

- [ ] **Step 1: Write failing CLI tests**

Create `tests_v2/test_cli.py` with:

```python
from __future__ import annotations

import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from io import StringIO


class CliTests(unittest.TestCase):
    def test_version_command_returns_zero_and_prints_version(self) -> None:
        from ytb_vps_v2.interfaces.cli import main

        output = StringIO()
        with redirect_stdout(output):
            exit_code = main(["version"])

        self.assertEqual(exit_code, 0)
        self.assertEqual(output.getvalue().strip(), "ytb-vps-v2 0.1.0.dev0")

    def test_module_entry_point_runs_development_cli(self) -> None:
        environment = os.environ.copy()
        environment["PYTHONPATH"] = "src"

        result = subprocess.run(
            [sys.executable, "-m", "ytb_vps_v2", "version"],
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            check=False,
            env=environment,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "ytb-vps-v2 0.1.0.dev0")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to prove the CLI module is absent**

Run:

```powershell
$env:PYTHONPATH = 'src'
python -m unittest tests_v2.test_cli -v
```

Expected: error with `ModuleNotFoundError: No module named 'ytb_vps_v2.interfaces'`.

- [ ] **Step 3: Implement the minimal development CLI**

Create `src/ytb_vps_v2/interfaces/__init__.py` with:

```python
"""Operator and development interfaces for v2."""
```

Create `src/ytb_vps_v2/interfaces/cli.py` with:

```python
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
```

Create `src/ytb_vps_v2/__main__.py` with:

```python
from ytb_vps_v2.interfaces.cli import main


raise SystemExit(main())
```

- [ ] **Step 4: Run CLI and package regression tests**

Run:

```powershell
$env:PYTHONPATH = 'src'
python -m unittest tests_v2.test_cli tests_v2.test_package_smoke -v
ytb-vps-v2 version
```

Expected: 4 tests pass and the installed command prints `ytb-vps-v2 0.1.0.dev0`.

- [ ] **Step 5: Review and commit Task 2**

Run:

```powershell
git diff --check
git diff -- src/ytb_vps_v2/interfaces src/ytb_vps_v2/__main__.py tests_v2/test_cli.py
git add -- src/ytb_vps_v2/interfaces/__init__.py src/ytb_vps_v2/interfaces/cli.py src/ytb_vps_v2/__main__.py tests_v2/test_cli.py
git diff --cached --name-status
git commit -m "feat(v2): add development cli"
```

Expected: one non-empty commit containing only the four Task 2 files.

### Task 3: Python 3.10 CI contract and developer instructions

**Files:**
- Create: `.github/workflows/v2-ci.yml`
- Create: `docs/rebuild/DEVELOPMENT.md`
- Create: `tests_v2/test_ci_contract.py`

**Interfaces:**
- Consumes: editable package install and `tests_v2` unittest discovery from Tasks 1–2.
- Produces: a GitHub Actions job named `v2-python310`; exact local setup and verification commands for Phase 1.

- [ ] **Step 1: Write the failing CI contract test**

Create `tests_v2/test_ci_contract.py` with:

```python
from __future__ import annotations

import unittest
from pathlib import Path


class CiContractTests(unittest.TestCase):
    def test_workflow_installs_and_tests_v2_on_python_310(self) -> None:
        workflow = Path(".github/workflows/v2-ci.yml").read_text(encoding="utf-8")

        self.assertIn("v2-python310:", workflow)
        self.assertIn("python-version: '3.10'", workflow)
        self.assertIn("python -m pip install --no-deps -e .", workflow)
        self.assertIn("python -m compileall -q src tests_v2", workflow)
        self.assertIn("python -m unittest discover -s tests_v2 -t . -v", workflow)

    def test_development_guide_keeps_public_entry_point_unchanged(self) -> None:
        guide = Path("docs/rebuild/DEVELOPMENT.md").read_text(encoding="utf-8")

        self.assertIn("ytb-vps-v2 version", guide)
        self.assertIn("public `ytb-vps` command remains legacy", guide)
        self.assertIn("Python 3.10", guide)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test to prove CI and docs are absent**

Run:

```powershell
$env:PYTHONPATH = 'src'
python -m unittest tests_v2.test_ci_contract -v
```

Expected: errors because `.github/workflows/v2-ci.yml` and `docs/rebuild/DEVELOPMENT.md` do not exist.

- [ ] **Step 3: Add the Python 3.10 workflow**

Create `.github/workflows/v2-ci.yml` with:

```yaml
name: v2-ci

on:
  pull_request:
  push:
    branches:
      - rebuild/v2

permissions:
  contents: read

jobs:
  v2-python310:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.10'
          cache: pip
      - name: Install v2 package
        run: python -m pip install --no-deps -e .
      - name: Compile v2
        run: python -m compileall -q src tests_v2
      - name: Test v2
        run: python -m unittest discover -s tests_v2 -t . -v
```

- [ ] **Step 4: Add exact developer instructions**

Create `docs/rebuild/DEVELOPMENT.md` with:

```markdown
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
```

- [ ] **Step 5: Run the complete Phase 1 test and compile gate**

Run:

```powershell
$env:PYTHONPATH = 'src'
python -m compileall -q src tests_v2
python -m unittest discover -s tests_v2 -t . -v
ytb-vps-v2 version
```

Expected: compile succeeds, 6 tests pass, and the command prints `ytb-vps-v2 0.1.0.dev0`.

- [ ] **Step 6: Review and commit Task 3**

Run:

```powershell
git diff --check
git diff -- .github/workflows/v2-ci.yml docs/rebuild/DEVELOPMENT.md tests_v2/test_ci_contract.py
git add -- .github/workflows/v2-ci.yml docs/rebuild/DEVELOPMENT.md tests_v2/test_ci_contract.py
git diff --cached --name-status
git commit -m "ci(v2): add python 3.10 package gate"
```

Expected: one non-empty commit containing only the three Task 3 files.

### Task 4: Phase 1 verification and audit

**Files:**
- Modify: `docs/rebuild/AUDIT-LOG.md`

**Interfaces:**
- Consumes: all Task 1–3 commits and their test evidence.
- Produces: an append-only Phase 1 audit entry containing the actual full commit hashes, remaining Python 3.10 execution risk, and Phase 2 as the next step.

- [ ] **Step 1: Run the full relevant regression suite**

Run:

```powershell
$env:PYTHONPATH = 'src'
python -m compileall -q src tests_v2
python -m unittest discover -s tests_v2 -t . -v
python -c "import sys, ytb_vps_v2; assert (3, 10) <= sys.version_info[:2] < (3, 13); assert ytb_vps_v2.__version__ == '0.1.0.dev0'"
ytb-vps-v2 version
```

Expected: compile succeeds, 6 tests pass, the import assertion exits zero, and the CLI prints `ytb-vps-v2 0.1.0.dev0`.

- [ ] **Step 2: Capture exact Phase 1 commit evidence**

Run:

```powershell
git log -3 --format='%H %s'
Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
git status --short --branch
```

Expected: the three latest implementation commits are the Task 3, Task 2, and Task 1 commits, followed by a clean worktree. Record the full hashes exactly as printed.

- [ ] **Step 3: Append the Phase 1 audit entry**

Use `apply_patch` to append an entry to `docs/rebuild/AUDIT-LOG.md` with these exact facts:

- Objective: create the independent installable v2 package, development CLI, Python 3.10 CI contract, and developer guide without changing legacy.
- Contract/invariant: `src/ytb_vps_v2` does not import `ytb_vps`; only `ytb-vps-v2` is registered; production target is Python 3.10.
- Changed files: list every file from Tasks 1–3 plus `docs/rebuild/AUDIT-LOG.md`.
- Tests/gates: record the exact commands from Step 1, staged filename reviews, secret filename gate, and `git diff --check`.
- Result: record the exact passing test count and CLI output.
- Phase commits: insert the three full hashes printed by Step 2.
- Remaining risk: Python 3.10 is not installed on the local Windows host, so the GitHub Actions run remains the Python 3.10 execution evidence once the branch is pushed by an authorized user.
- Next step: create and execute the Phase 2 canonical timeline/domain-model plan.

- [ ] **Step 4: Review and commit the audit entry**

Run:

```powershell
git diff --check
git diff -- docs/rebuild/AUDIT-LOG.md
git add -- docs/rebuild/AUDIT-LOG.md
git diff --cached --name-status
git commit -m "docs(rebuild): audit package scaffold phase"
git status --short --branch
```

Expected: the audit commit succeeds and the worktree is clean.
