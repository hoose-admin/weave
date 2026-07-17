---
name: weave-terminal
description: "Knowledge + debugging playbook for the weave dashboard's in-browser terminal — the xterm.js (DOM renderer) → ttyd → dtach → shell stack under `.weave/`. Encodes the layer-localization diagnostic (the Playwright buffer-probe that reads xterm's buffer and compares it to ground truth, plus bypass-the-persistence-layer and renderer-swap), and the history of why the stack is what it is: tmux was REMOVED from the render path because its screen re-emit was incomplete for scroll/line-delete and desynced xterm.js (the ghost-line-after-delete, blank bands, resize corruption were one bug); dtach passes the app's bytes straight through, so the browser renders vim's real escapes. Produces a diagnosis plus the specific change to apply."
when_to_use: "Vim or a TUI renders wrong in the weave browser terminal — garbled/doubled/stale glyphs, a ghost line after a delete, blank/missing bands after scrolling, misaligned or wrong-wrapping text (especially after resize or tab-switch), missing colors, or a session stuck at 80×24. Also: 'how does the weave terminal stack work', 'why does the browser terminal look different from iTerm', 'debug ttyd/dtach/xterm rendering', 'should we bring back tmux'."
connects_to: []
kind: specialized
---

# Weave Terminal

Debugging playbook + model for the weave dashboard's in-browser terminal: the
`xterm.js (DOM renderer) → ttyd → dtach → shell` stack under `.weave/`. Diagnose
"vim/TUI renders wrong" reports by **localizing the layer with ground truth**
(read xterm's actual buffer and diff it against what the app emitted) instead of
guessing — the failure mode that made these bugs recur.

## The load-bearing history (read this before "fixing" rendering)

The ghost-line-after-delete, the blank bands after scroll, and the resize
corruption were **one bug: tmux re-emitting the screen to the browser.** tmux is
a second terminal emulator — it parses the app's output into its own grid and
re-emits fresh escapes to the client. That re-emit is **incomplete for scroll /
line-delete**: on `dd` tmux sends the post-scroll diff (the new bottom line +
status) but never sends the scroll itself, so xterm's shifted rows keep their old
content. Proven at the byte level: with tmux in the path xterm's buffer stayed
stale (TERM-independent); with tmux removed, xterm received vim's real
`\E[10;39r` scroll-region delete and rendered it correctly.

So tmux was **removed from the render path** (TKT / July 2026). Persistence now
comes from **dtach** — a byte-passthrough pty multiplexer that does NOT parse or
re-emit. The browser gets the app's original escapes; xterm.js renders them.

**Do NOT reintroduce tmux for terminals, and do NOT re-add the scaffolding that
used to paper over its re-emit** (all deleted): the `xterm-256color-weave`
scroll-region terminfo, `applySessionOptions`, `refreshSession` / the
`/api/terminals/:id/resync` route + client `resyncSoon`, and the xterm
**CanvasAddon** (its texture-atlas staleness was a *second*, independent ghost
source — the DOM renderer is correct and needs no compensation). If a rendering
bug returns, it is almost certainly in xterm.js or your test, not in a missing
tmux/terminfo/canvas layer.

## The stack now

```
browser xterm.js (FitAddon only → built-in DOM renderer)   ← renders glyphs
   ⇅ WebSocket (ttyd "tty" protocol: 0x30 output / 0x31 resize)
ttyd  (-W, -T xterm-256color, localhost)                   ← PTY host
   ⇅ pty
dtach (-a <socket> -E -z -r winch)                         ← byte passthrough + persistence
   ⇅ pty
shell → vim
```

- No re-emit: dtach relays bytes untouched, so the app's TERM is plain
  `xterm-256color` (matching xterm.js) and there is no terminfo workaround.
- Persistence: the detached `dtach -n <socket> <shell>` master is a daemon that
  outlives ttyd / the browser / a dashboard restart. Liveness = the socket
  exists; `dtach -p <socket>` injects keystrokes (the `tmux send-keys` analog).
- Status dots come from the file-based `weave_terminal_live.ts` claude hook
  (env `WEAVE_*`), independent of the terminal layer. There is no `capture-pane`
  fallback anymore (a plain shell with no hook data just reads idle).

## When to invoke

- "vim renders garbled / ghost line after delete / blank bands / stale rows" → run the buffer-probe diagnostic
- "text misaligned or wraps wrong (esp. after resize / tab switch)" → the resize / re-fit model
- "how does the weave terminal stack work", "why is a session stuck at 80×24", "why did we drop tmux" → read the model sections

## When NOT to invoke

- Session **lifecycle** bugs (won't start/persist, port conflicts, dtach socket
  issues) — that's `.weave/lib/terminals.ts` logic / `docker-colima`, not rendering.
- Dashboard **graph** views — `weave-dataflow-graph` / `weave-schema-graph` / `weave-codebase-graph`.
- Copy/paste or keybinding behavior — the OSC-52 handler / `attachCustomKeyEventHandler` in `terminal-xterm.js`.

## Procedure — buffer-probe diagnostic (do FIRST; do not guess)

The reliable way to localize a render bug is to read xterm's **buffer model**
(what xterm thinks the screen is, independent of paint) and compare it to ground
truth. This is what caught the tmux re-emit bug after two wrong guesses (canvas,
then terminfo). Drive the real client headless with the vendored Playwright
(chromium at `.weave/cache/browsers`):

1. **Read xterm's buffer.** `page.evaluate(() => { const g = term; const b = g.buffer.active; … b.getLine(b.baseY+i).translateToString(true) … })`. `term` is a top-level `const` in the classic script, reachable from `page.evaluate`. Force a paint with `g.refresh(0, g.rows-1)` so a stale screenshot can't fool you (headless throttles rAF).
2. **Establish ground truth.** For a scripted edit (e.g. open a file of `GHOSTLINE-01..20`, `10G`, `dd`) the correct buffer is known: line 10 must become `GHOSTLINE-11`. If xterm's buffer shows the *old* value, the buffer never received the update — a transport/re-emit bug, NOT a paint/renderer bug.
3. **Bypass the persistence layer.** Spawn `ttyd -T xterm-256color -W <shell>` (no dtach, no tmux) and repro. Correct there but wrong through dtach ⇒ the persistence layer; wrong even direct ⇒ ttyd/xterm.js. (This is how tmux was convicted: correct without it, stale with it.)
4. **Capture the bytes.** Tee `term.write` in the browser (`window.__w.push(dec.decode(x))`) and dump what actually arrived around the failing keystroke. Complete escapes + wrong buffer ⇒ xterm parse bug; missing escapes (e.g. no scroll) ⇒ the layer that emitted them.
5. **Renderer swap (only if bytes are correct but pixels wrong).** The DOM renderer is default (no addon). A canvas/webgl addon would be the only reason to suspect glyph-cache staleness — we don't load one, so this is rarely the answer now.

See `${CLAUDE_SKILL_DIR}` scratch harnesses pattern: create a throwaway session
via `POST /api/terminals`, drive `/terminal-xterm.html?port=<p>`, `DELETE` after.

## The resize / re-fit model

**Stale 80×24 handshake.** A terminal iframe opens its WebSocket while its tab is
hidden; `safeFit()` no-ops at 0×0, so the handshake sends xterm's default 80×24.
Fix: `activate()` in `terminal.js` posts `weave-activate` to the now-visible
iframe; `terminal-xterm.js` re-fits (fires `onResize → sendResize`, correcting the
pty) then repaints. Tell-tale: a session rendering at 80×24 while active.

**Resize with vim open.** Just works now — `onResize → sendResize` tells the pty
the new size, the app gets SIGWINCH and redraws itself, and dtach passes that
redraw straight through. No resync/`refresh-client` needed (that was tmux-only).

## Scrollback on reload (dtach has none) — client-side restore

dtach keeps **no server-side scrollback** (tmux did, and replayed it on attach).
So on a hard reload the reattach only sends `winch`: a full-screen TUI
(claude/vim) redraws itself and looks fine, but a **plain shell comes back
blank**. This is the expected consequence of dropping tmux, not a render bug — do
NOT reach for the buffer-probe diagnostic for it.

The fix is **client-side, not a return to tmux** (`terminal-xterm.js`): on save,
SERIALIZE xterm's parsed buffer to text and stash it in `sessionStorage` keyed by
port; on load, write it back before `connect()`. Two traps, both proven by test
(scratch harness drives `/terminal-xterm.html?port=`, produces marked output,
`page.reload()`, reads the buffer + the reattach WS frames):

1. **Serialize the GRID, not the raw byte stream.** Replaying captured output
   bytes is defeated by screen-clearing prompts — this repo's zsh prompt emits
   `ESC[H ESC[J` on every redraw, so a raw replay's own final clear wipes all the
   restored history (byte replay tested → left only the last prompt). Serialize
   `term.buffer.normal` (`serializeBuffer`, capped `REPLAY_MAX_LINES`, trailing
   blanks trimmed). Normal buffer only, so a TUI tab restores its underlying shell
   history, never a stale alt-screen frame. **Colours preserved** by walking cells
   and re-emitting SGR (`serializeLine`/`cellSgr` — palette + RGB + the common
   attribute flags, style change emitted only on a run boundary, reset at line end)
   — no xterm SerializeAddon (a download) needed; verified a palette-256 colour
   round-trips through the reload.
2. **Restore into SCROLLBACK, not the viewport.** On reattach the shell redraws
   its prompt with `ESC[H ESC[J` (home + erase-below), clearing the whole viewport
   — captured live as a 104-byte reattach frame. Anything restored *into the
   viewport* is wiped by it. `ESC[J` can't touch scrollback, so `restoreScrollback`
   writes the history **followed by `term.rows` newlines**, scrolling it up out of
   the viewport; the shell then draws its prompt into the cleared viewport, leaving
   history one scroll-up away with no gap. Then `revealHistoryAfterReattach` (a
   ~500 ms post-connect `term.scrollLines(-(rows-4))`, gated on `didRestore`) nudges
   the viewport up so recent history is visible on load with the prompt kept near
   the bottom — a normal-terminal look, not a lone prompt on a blank screen. Any
   keypress/scroll snaps back to the live prompt (xterm scrolls to bottom on input).
3. **Restore must run at the pane's REAL size** — else it's flaky (measured 3/4).
   The `+term.rows` padding is sized for the viewport at restore time. Every iframe
   mounts **hidden** (80×24; `safeFit` no-ops at 0×0), and `restoreScrollback` runs
   at script load. If the pane is later shown and resized (24→45), the resize pulls
   the scrollback history **back down into the viewport**, where the shell's
   resize-triggered clear wipes it. Fix lives in **`terminal.js`**: `activate()`
   persists the tab id to `localStorage` (`ACTIVE_TERM_KEY`) and `load()`
   re-activates it on reload instead of always `tabs[0]` — so the pane you were
   viewing is un-hidden *before* its iframe script runs and restores at full size
   (verified 5/5). Background tabs (not the reloaded-active one) stay best-effort.

`scheduleSave` debounces a save 600 ms after output; `pagehide`/`beforeunload`
force a final save. `sessionStorage` survives reload, auto-clears on tab close.
Caveats: background tabs restore at 80×24 and can lose history on their first
show+resize; a `term.rows`-blank gap can appear for a NON-clearing prompt or a
running non-TUI process (no reattach clear to absorb the padding). True tmux-style
*inline* screen restore (recent output visible in the viewport, not just
scrollback) is blocked by the shell's own winch clear and would need a server-side
buffer or a `-r winch` change. Repro/verify with the iframe harness (drive
`/terminal`, POST a session, type, `page.reload()`, read the frame buffer) — a
top-level `/terminal-xterm.html` harness hides the hidden-iframe resize race.

## Recovery levers

- **`repaint()`** (`terminal-xterm.js`) = `term.refresh(0, rows-1)`; auto-fires on
  focus, live scheme change, and tab-activate. Cheap DOM re-render — there is no
  glyph cache to clear.
- **Reconnect** re-attaches ttyd's `dtach -a` to the surviving master; `-r winch`
  makes full-screen apps redraw on attach.
- **Kill switch** (`#term-kill` → `killAllSessions`) reaps every weave ttyd + dtach
  master. Unlike the old `tmux kill-server`, it touches only weave's sessions.

## Key files

- `.weave/lib/terminals.ts` — session lifecycle: `spawnMaster` (`dtach -n`),
  `ttydArgs` (`dtach -a`), `injectBytes`/`sendKeys`/`sourceCmdHook` (`dtach -p`),
  `dtachHasSession`, `killMaster`, `killAllSessions`, `reconcile`/`respawnTtyd`.
- `.weave/public/terminal-xterm.js` — Terminal construction (FitAddon, DOM
  renderer), `safeFit`, `repaint`, the `message`/`weave-activate` listener,
  `serializeBuffer`/`serializeLine`/`cellSgr`/`persistScrollback`/`scheduleSave`/
  `restoreScrollback`/`revealHistoryAfterReattach` (sessionStorage grid-serialize
  reload restore, colours preserved), key handler + OSC-52 clipboard.
- `.weave/public/terminal.js` — `activate()` (`weave-activate`; persists
  `ACTIVE_TERM_KEY`), `load()` (re-activates the persisted tab on reload so it
  restores at full size), `ensureFrame()` (iframe `?port=…`), `killSwitch()`.
- `.weave/server.ts` — `/api/terminals` routes (create/list/kill/rename/reorder,
  `kill-server`). No `/resync` route anymore.
- `lib/terminal-status.ts` (the `capture-pane` status fallback) was DELETED with
  tmux; the `weave_terminal_live.ts` hook is the only status source.

## Prerequisites

- `ttyd` and `dtach` on PATH (`brew install ttyd dtach`). No tmux, no `tic`/terminfo.
- The dashboard runs via `bun --hot`; **client JS/HTML changes need a browser
  refresh + a ttyd respawn (close/reopen the tab)**, and a *structural* server
  change (new module exports, lifecycle rewrites) can wedge `bun --hot` — restart
  the dashboard process to load it, and verify the fix on a throwaway instance
  (`PORT=5175 bun server.ts`) rather than trusting the hot-reloaded one.
