"""Build a standalone executable for the Local Cursor app using PyInstaller."""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path
from typing import List, Optional

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKEND_ROOT = PROJECT_ROOT / "backend"
FRONTEND_ROOT = PROJECT_ROOT / "frontend"
DEFAULT_DIST = BACKEND_ROOT / "dist"
DEFAULT_BUILD = BACKEND_ROOT / "build"


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build a Windows executable for Local Cursor")
    parser.add_argument("--name", default="LocalCursor", help="Executable name (default: %(default)s)")
    parser.add_argument(
        "--onefile",
        action="store_true",
        help="Package everything into a single executable (slower to start).",
    )
    parser.add_argument("--icon", type=Path, help="Optional path to an .ico/.icns icon file")
    parser.add_argument(
        "--dist", type=Path, default=DEFAULT_DIST, help="Destination directory for the build (default: %(default)s)"
    )
    parser.add_argument(
        "--workpath",
        type=Path,
        default=DEFAULT_BUILD,
        help="Temporary work directory for PyInstaller (default: %(default)s)",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove previous build/dist directories before building.",
    )
    parser.add_argument(
        "--print-only",
        action="store_true",
        help="Show the PyInstaller command without running it.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only check that the build prerequisites are installed.",
    )
    return parser.parse_args(argv)


def ensure_pyinstaller() -> "module":
    try:
        import PyInstaller.__main__ as pyinstaller  # type: ignore
    except ImportError as exc:
        message = (
            "PyInstaller is required. Install it with `pip install -r backend/requirements-build.txt` "
            "or `pip install pyinstaller`."
        )
        raise SystemExit(message) from exc
    return pyinstaller


def clean_directories(*paths: Path) -> None:
    for path in paths:
        if path.exists():
            shutil.rmtree(path)


def build_executable(args: argparse.Namespace) -> None:
    pyinstaller = ensure_pyinstaller()

    if args.clean:
        clean_directories(args.dist, args.workpath)

    args.dist.mkdir(parents=True, exist_ok=True)
    args.workpath.mkdir(parents=True, exist_ok=True)

    add_data_sep = ";" if os.name == "nt" else ":"
    frontend_data = f"{FRONTEND_ROOT.resolve()}{add_data_sep}frontend"

    pyinstaller_args = [
        str(BACKEND_ROOT / "launcher.py"),
        "--noconfirm",
        "--name",
        args.name,
        "--distpath",
        str(args.dist.resolve()),
        "--workpath",
        str(args.workpath.resolve()),
        "--add-data",
        frontend_data,
    ]

    workspace_dir = PROJECT_ROOT / "workspace"
    if workspace_dir.exists():
        pyinstaller_args.extend(["--add-data", f"{workspace_dir.resolve()}{add_data_sep}workspace"])

    if args.icon:
        pyinstaller_args.extend(["--icon", str(args.icon.resolve())])

    if args.onefile:
        pyinstaller_args.append("--onefile")

    if args.print_only:
        print("PyInstaller command:")
        print(" ".join(pyinstaller_args))
        return

    print("==> Building executable with PyInstaller…")
    pyinstaller.run(pyinstaller_args)
    print(f"Executable written to: {args.dist.resolve() / (args.name + ('.exe' if os.name == 'nt' else ''))}")


def main(argv: Optional[List[str]] = None) -> None:
    args = parse_args(argv)
    if args.check:
        ensure_pyinstaller()
        print("PyInstaller is available. Ready to build.")
        return
    build_executable(args)


if __name__ == "__main__":
    main(sys.argv[1:])
