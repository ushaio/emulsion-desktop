"""Temporary forwarding shim (delete after this session).

The running ZCode session registered the Trellis PreToolUse(Bash) hook with a
path relative to the repo root, so it stops resolving once the shell cwd moves
below the root (e.g. desktop/frontend). Delegate to the real hook at the repo
root, located by walking up to the directory that contains .trellis.
"""
import os
import runpy
import sys


def _find_real_hook() -> str | None:
    current = os.path.dirname(os.path.abspath(__file__))
    while True:
        candidate = os.path.join(current, ".zcode", "hooks", "inject-shell-session-context.py")
        if os.path.isfile(candidate) and os.path.abspath(candidate) != os.path.abspath(__file__):
            return candidate
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def main() -> int:
    real = _find_real_hook()
    if real is None:
        return 0
    runpy.run_path(real, run_name="__main__")
    return 0


if __name__ == "__main__":
    sys.exit(main())
