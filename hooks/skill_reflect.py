#!/usr/bin/env python3
"""End-of-turn skill/script self-reflection hook (one script, two events).

Wired to UserPromptSubmit + Stop in .claude/settings.json.

  UserPromptSubmit  -> ARM: a new user turn started; record where it begins in the
                       transcript (line count) so Stop can scope "what did this turn do".
  Stop              -> if armed AND this turn was SUBSTANTIVE (edited files), block the stop
                       ONCE and feed back a
                       short end-of-turn wrap-up with three parts: (1) should an EXISTING
                       skill/script/doc be updated with this turn's lesson, or — for an
                       action likely to recur 2+ times (a migration, a repeated refactor, a
                       multi-file generator) — should a NEW skill exist (ask first)?;
                       (2) a one-sentence summary of what the turn did for the user (the
                       actual work, ignoring any skill/script housekeeping from part 1); and
                       (3) a one-sentence list of action items the user should review, if
                       any. Conversational / read-only turns pass through silently.

Loop-safe: `armed` is set only by a real user prompt and cleared on the first Stop, so
the reflection continuation this triggers cannot re-trigger itself. `stop_hook_active`
is honored too. Fails OPEN on any error (never wedges a session).

State: $TMPDIR/claude-skill-reflect-<session_id>.json
"""

import json
import os
import re
import sys
from pathlib import Path

STATE_DIR = Path(os.environ.get("TMPDIR", "/tmp"))
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
# File edits are the unambiguous "did substantive work" signal. Read-only / conversational
# turns (no edits) pass through silently — keep this conservative so the wrap-up doesn't
# fire on a pure `git status` or `grep` turn.

# Kept as tight as the three-part ask allows: Claude Code prints a blocking Stop hook's full
# `reason` to the terminal, so every extra line is console noise. The full skill criteria
# (LESSON -> existing asset; NEW skill on the >=2x rule, ask first) live in CLAUDE.md; part 1
# here is just the trigger, biased to "nothing" unless clearly reusable. Parts 2-3 add a
# one-sentence turn summary + an action-items line for the user, both ignoring part 1.
REFLECTION = (
    "[skill-reflect] One-time end-of-turn wrap-up — do these in order:\n"
    "1. Skill/spec: if this turn revealed a REUSABLE lesson an existing skill/spec should "
    "encode, or a NEW 2x+ recurring workflow with no skill (ask before creating), do it now; "
    "otherwise skip this part silently (no 'no learning' line).\n"
    "2. Then output exactly these two lines, IGNORING any part-1 skill/script housekeeping:\n"
    "**Summary: <one sentence on what this turn did in response to my prompt>\n\n"
    "**User Action items: <one sentence of action items I should check, or 'none'>"
)


def _state_path(session_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", session_id or "default")
    return STATE_DIR / f"claude-skill-reflect-{safe}.json"


def _load(p: Path) -> dict:
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _save(p: Path, st: dict) -> None:
    try:
        p.write_text(json.dumps(st))
    except Exception:
        pass


def _line_count(path: str) -> int:
    try:
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except Exception:
        return 0


def _turn_was_substantive(path: str, start: int) -> bool:
    """True if any assistant tool_use since `start` line was a file edit or a Bash op."""
    try:
        lines = Path(path).read_text(errors="ignore").splitlines()
    except Exception:
        return False
    for ln in lines[max(0, start) :]:
        try:
            rec = json.loads(ln)
        except Exception:
            continue
        msg = rec.get("message")
        content = msg.get("content") if isinstance(msg, dict) else None
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict) or b.get("type") != "tool_use":
                continue
            name = b.get("name")
            if name in EDIT_TOOLS:
                return True
    return False


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    event = data.get("hook_event_name") or ""
    session_id = (
        data.get("session_id") or os.environ.get("CLAUDE_SESSION_ID") or "default"
    )
    sp = _state_path(session_id)
    transcript = data.get("transcript_path") or ""

    if event == "UserPromptSubmit":
        _save(sp, {"armed": True, "start": _line_count(transcript)})
        sys.exit(0)

    if event == "Stop":
        if data.get("stop_hook_active"):
            sys.exit(0)
        st = _load(sp)
        if not st.get("armed"):
            sys.exit(0)
        st["armed"] = False  # disarm BEFORE deciding, so we can't loop
        _save(sp, st)
        if transcript and _turn_was_substantive(transcript, int(st.get("start", 0))):
            sys.stdout.write(
                json.dumps(
                    {
                        "decision": "block",
                        "reason": REFLECTION,
                        "systemMessage": "skill-reflect: end-of-turn wrap-up (skill check + summary + review)",
                    }
                )
            )
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
