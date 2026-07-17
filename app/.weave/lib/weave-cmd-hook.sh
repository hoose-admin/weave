# weave-cmd-hook.sh — record the last command run in a weave terminal.
#
# Sourced ONCE at session start by lib/terminals.ts (injected via `dtach -p`). On each
# command it writes the command line to $WEAVE_LIVE_DIR/$WEAVE_TERM_ID.cmd, which
# the dashboard reads to label the terminal tab with the last command instead of
# the directory. Inert (and returns cleanly) unless the weave env vars are set, so
# sourcing it in a non-weave shell is a no-op. Registered additively (add-zsh-hook
# / DEBUG trap) so it never clobbers the user's own preexec hooks.

[ -n "$WEAVE_TERM_ID" ] && [ -n "$WEAVE_LIVE_DIR" ] || return 0 2>/dev/null || exit 0

__weave_record_cmd() {
  local line="$1"
  [ -n "${line// /}" ] || return 0
  mkdir -p "$WEAVE_LIVE_DIR" 2>/dev/null
  printf '%s' "$line" > "$WEAVE_LIVE_DIR/$WEAVE_TERM_ID.cmd" 2>/dev/null
}

if [ -n "$ZSH_VERSION" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null
  __weave_preexec() { __weave_record_cmd "$1"; }
  add-zsh-hook preexec __weave_preexec 2>/dev/null
elif [ -n "$BASH_VERSION" ]; then
  __weave_debug() {
    [ -n "$COMP_LINE" ] && return
    [ "$BASH_COMMAND" = "${PROMPT_COMMAND%%;*}" ] && return
    __weave_record_cmd "$BASH_COMMAND"
  }
  trap '__weave_debug' DEBUG
fi
