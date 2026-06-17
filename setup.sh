#!/usr/bin/env bash
# weave setup — vendor the local ticket dashboard + Claude Code skills into a
# target repo, scaffold the board, build the codebase graphs, and (optionally)
# run the first-pass bug-scan that fills the backlog.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT=5174
PORT_SET=0
DO_SCAN=1
DO_START=0
TARGET=""

usage() {
  cat <<'EOF'
weave setup — install the weave ticket board + skills into a repo.

usage: bash setup.sh [TARGET_REPO] [options]

  TARGET_REPO   path to the repo to weave-enable (default: current directory)

options:
  --no-scan     skip the first-run repo-map + bug-scan skill passes (Claude Code)
  --start       start the dashboard when setup finishes
  --port N      dashboard port (default: 5174)
  -h, --help    show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-scan) DO_SCAN=0 ;;
    --start)   DO_START=1 ;;
    --port)    PORT="${2:?--port needs a value}"; PORT_SET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)        echo "unknown option: $1" >&2; usage; exit 2 ;;
    *)         if [ -z "$TARGET" ]; then TARGET="$1"; else echo "unexpected arg: $1" >&2; exit 2; fi ;;
  esac
  shift
done

TARGET="${TARGET:-$PWD}"
TARGET="$(cd "$TARGET" 2>/dev/null && pwd || true)"
[ -n "$TARGET" ] || { echo "✗ target repo not found" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────
command -v bun >/dev/null 2>&1 || { echo "✗ bun is required — install from https://bun.sh" >&2; exit 1; }
command -v git >/dev/null 2>&1 || echo "⚠ git not found — weave works without it, but version control is recommended"
HAVE_CLAUDE=0; command -v claude >/dev/null 2>&1 && HAVE_CLAUDE=1

if [ "$TARGET" = "$SCRIPT_DIR" ]; then
  echo "✗ target is the weave repo itself — pass the path to the repo you want to weave-enable" >&2
  exit 1
fi

echo "→ weave setup"
echo "    weave:  $SCRIPT_DIR"
echo "    target: $TARGET"
echo "    port:   $PORT"

# ── 1. vendor the dashboard app ──────────────────────────────────────────────
echo "→ vendoring dashboard into $TARGET/.weave"
mkdir -p "$TARGET/.weave"
rsync -a --exclude 'cache' --exclude 'node_modules' "$SCRIPT_DIR/app/.weave/" "$TARGET/.weave/"

# ── 2. install skills + hooks, merge settings ────────────────────────────────
echo "→ installing skills + hooks into $TARGET/.claude"
mkdir -p "$TARGET/.claude/skills" "$TARGET/.claude/hooks"
rsync -a "$SCRIPT_DIR/skills/" "$TARGET/.claude/skills/"
rsync -a "$SCRIPT_DIR/hooks/"  "$TARGET/.claude/hooks/"
bun "$SCRIPT_DIR/scripts/merge-settings.ts" "$SCRIPT_DIR/settings.template.json" "$TARGET/.claude/settings.json"

# ── 3. scaffold the .tickets board ───────────────────────────────────────────
echo "→ scaffolding .tickets board (9 buckets + ADRs)"
for b in scratch 0-backlog 1-staging 2-stuck 3-building 4-testing 5-validating 6-complete 7-archive ADRs; do
  mkdir -p "$TARGET/.tickets/$b"
  [ -e "$TARGET/.tickets/$b/.gitkeep" ] || : > "$TARGET/.tickets/$b/.gitkeep"
done

# ── 4. config + starter CLAUDE.md ────────────────────────────────────────────
if [ ! -e "$TARGET/weave.config.json" ]; then
  printf '{\n  "repoRoot": ".",\n  "ticketsRoot": ".tickets",\n  "port": %s\n}\n' "$PORT" > "$TARGET/weave.config.json"
  echo "→ wrote weave.config.json"
elif [ "$PORT_SET" = 1 ]; then
  echo "⚠ weave.config.json already exists — leaving it untouched; edit its \"port\" by hand to make --port $PORT stick for 'bun run start'"
fi
if [ ! -e "$TARGET/CLAUDE.md" ]; then
  cp "$SCRIPT_DIR/CLAUDE.template.md" "$TARGET/CLAUDE.md"
  echo "→ wrote CLAUDE.md (starter — customize it for your project)"
else
  echo "⚠ CLAUDE.md already exists — review $SCRIPT_DIR/CLAUDE.template.md for weave conventions to fold in"
fi

# ── 5. build the dashboard graphs (deterministic — no Claude Code needed) ─────
echo "→ building dashboard graphs"
( cd "$TARGET/.weave" && bun run build:graphs ) \
  || echo "⚠ graph build hit an error — the dashboard will build graphs on demand instead"

# ── 6. first-run skill pass: bug-scan (fills the backlog from your own code) ──
#    (dataflow + schemas graphs are deterministic — already built in step 5.)
run_skill() {  # $1 = prompt, $2 = label
  echo "→ running $2 …"
  if ( cd "$TARGET" && claude -p "$1" --permission-mode acceptEdits ); then
    echo "  ✓ $2 done"
  else
    echo "  ⚠ $2 via 'claude -p' didn't complete — run it interactively (see below)"
  fi
}
if [ "$DO_SCAN" = 1 ] && [ "$HAVE_CLAUDE" = 1 ]; then
  run_skill "Use the bug-scan skill to scan this codebase for likely bugs, verify them, and file backlog tickets." "bug-scan"
fi

# ── done ─────────────────────────────────────────────────────────────────────
cat <<EOF

✓ weave installed into $TARGET

  start the board:  cd "$TARGET/.weave" && bun run start
  then open:        http://127.0.0.1:$PORT
EOF
if [ "$DO_SCAN" != 1 ] || [ "$HAVE_CLAUDE" != 1 ]; then
  cat <<'EOF'

  enrich it from Claude Code (run inside your repo):
    /bug-scan     scan for bugs and fill the backlog
EOF
fi

if [ "$DO_START" = 1 ]; then
  echo "→ starting dashboard…"
  exec bash -c "cd '$TARGET/.weave' && PORT='$PORT' bun run start"
fi
