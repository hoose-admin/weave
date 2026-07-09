---
name: weave-terminal
description: "Knowledge + debugging playbook for the weave dashboard's in-browser terminal — the xterm.js → ttyd → tmux → shell rendering stack under `.weave/`. Encodes the layer-localization diagnostic (bypass-tmux, correct-TERM, native-attach, renderer-swap, byte-diff) that pinpoints which layer corrupts a full-screen TUI; the TERM/terminfo model (why the outer TERM must be xterm-compatible, not tmux-256color, and the weave-scoped `xterm-256color-weave` entry that cancels the scroll-region caps); the stale-80×24 resize / re-fit-on-activate model; and the force-redraw recovery levers. Produces a diagnosis plus the specific terminfo / session-option / renderer change to apply."
when_to_use: "Vim or a TUI renders wrong in the weave browser terminal — garbled/doubled/stale glyphs, blank or missing bands after scrolling, misaligned or wrong-wrapping text (especially after resize or tab-switch), washed-out or missing colors, or a session stuck at 80×24. Also: 'how does the weave terminal stack work', 'why does the browser terminal look different from iTerm', 'debug ttyd/tmux/xterm rendering'."
connects_to: []
kind: specialized
---

# Weave Terminal

Debugging playbook + model for the weave dashboard's in-browser terminal: the
`xterm.js → ttyd → tmux → shell` stack under `.weave/`. Use it to diagnose
"vim/TUI renders wrong" reports by **localizing the layer first** instead of
guessing (the failure mode that makes these bugs recur).

## When to invoke

- "vim renders garbled / blank bands / stale rows in the weave terminal" → run the layer-localization diagnostic
- "text misaligned or wraps wrong (esp. after resize / tab switch)" → the resize / re-fit model
- "colors washed out / no truecolor" → the TERM / terminfo model
- "how does the weave terminal stack work", "why is a session stuck at 80×24" → read the model sections

## When NOT to invoke

- Session **lifecycle** bugs (won't start, won't persist, port conflicts) — that's plain `.weave/lib/terminals.ts` logic / `docker-colima`, not a rendering issue.
- Dashboard **graph** views — that's `weave-dataflow-graph` / `weave-schema-graph` / `weave-codebase-graph`.
- Copy/paste or keybinding behavior — see the OSC-52 handler / `attachCustomKeyEventHandler` in `terminal-xterm.js`, not this skill.

## The stack (each layer can corrupt a full-screen TUI)

```
browser xterm.js (FitAddon + CanvasAddon)   ← renders glyphs
   ⇅ WebSocket (ttyd "tty" protocol: 0x30 output / 0x31 resize)
ttyd  (-W, -T <TERM>, localhost)             ← PTY host
   ⇅ pty
tmux  (new -A -s weave-<id>)                 ← PARSES + RE-EMITS escapes
   ⇅ pty
shell → vim
```

Key fact: **tmux does not pass the app's bytes through** — it parses them into its
own screen model and re-emits fresh escapes to xterm.js using the terminfo of
whatever TERM its client advertises. So corruption can live in tmux's re-emit, in
the TERM it re-emits *for*, or in xterm.js's renderer. Localize before fixing.

## Symptom → likely layer

- **Blank / missing bands after scroll, don't repaint** → tmux escape/TERM layer (scroll-region + bce).
- **Misaligned / wrong wrapping, esp. after resize or tab switch** → cols/rows PTY-size sync (stale handshake / window-size).
- **Garbled / doubled / stale glyphs even when NOT scrolling** → xterm.js CanvasAddon renderer.
- **Washed-out / wrong colors, no syntax highlight** → TERM / truecolor (RGB cap).

## Procedure — layer-localization diagnostic (do FIRST)

Cheap probes, each removes one variable. `weave-<id>` is the tmux session; the ttyd
port is in the session record. The browser render is the ONE thing you can't verify
from a shell — everything up to "bytes tmux emits" you can.

1. **Bypass tmux.** `ttyd -p 7690 -i 127.0.0.1 -W -T xterm-256color zsh`, browse `/terminal-xterm.html?port=7690`, repro. Correct ⇒ tmux is the culprit; still wrong ⇒ ttyd/xterm.js.
2. **Correct outer TERM, no override.** `ttyd -p 7691 -i 127.0.0.1 -W -T xterm-256color tmux new -A -s difftest`, repro. Correct ⇒ the wrong outer TERM was the bug. Only correct after `set -ga terminal-overrides ",xterm-256color:csr@:indn@:rin@"` ⇒ a genuine scroll-region race; keep that override, re-keyed to xterm.
3. **Bypass the browser.** From native iTerm, `tmux attach -t weave-<id>`, repro. Correct in iTerm but wrong in browser ⇒ xterm.js/CanvasAddon; wrong in iTerm too ⇒ tmux/TERM.
4. **Renderer swap.** Comment out the `CanvasAddon` load in `terminal-xterm.js` → DOM renderer; repro. DOM fixes it ⇒ Canvas glyph bug.
5. **Byte-diff (tiebreaker).** Capture tmux's output with `tmux … \; pipe-pane -o 'cat >> /tmp/a.raw'`; tee `term.write` in `terminal-xterm.js` to a downloadable buffer. Identical bytes + wrong pixels ⇒ renderer; divergent bytes ⇒ tmux/TERM.

**Decision:** correct-without-tmux OR correct-with-`-T xterm-256color` ⇒ TERM/tmux fix.
Correct-in-iTerm-only / DOM-fixes-it / identical-bytes ⇒ renderer fix. Divergent
bytes / wrong everywhere ⇒ TERM/tmux, else fall back to dropping tmux.

## The TERM / terminfo model (the #1 root cause)

xterm.js is **xterm-compatible**, so tmux's OUTER client TERM (set by ttyd `-T`)
must describe *xterm* — NOT `tmux-256color` (that's the value for programs *inside*
tmux). Advertising `tmux-256color` outside makes tmux drive the browser with the
wrong caps. Confirm with `infocmp -d xterm-256color tmux-256color`:

- **`bce: T:F`** — xterm has back-color-erase; tmux-256color doesn't → cleared cells don't fill → **blank bands**.
- **`cuu1: \E[A vs \EM`** — cursor-up is a plain move in xterm but **reverse-index (a scroll)** in tmux-256color → scroll corruption.
- `clear`, `enacs`, `indn`/`rin` also differ.

Weave's fix (`.weave/lib/terminals.ts`):

- `ensureWeaveTerminfo()` compiles a private entry **`xterm-256color-weave`** = `use=xterm-256color` with `csr@ indn@ rin@` cancelled, into `~/.terminfo` via `tic -x` (idempotent; falls back to plain `xterm-256color` if `tic` is missing).
- `ttydTerm()` returns that entry, so **only weave's ttyd clients** advertise it — the scroll-region disable is self-scoping (the user's iTerm tmux is untouched); no server-wide `terminal-overrides` hack needed.
- `applySessionOptions()` sets `default-terminal tmux-256color` (the inside TERM), `window-size latest`, and appends `terminal-features ",xterm-256color-weave:RGB"` for 24-bit color.

Verify without a browser: `ps -o command= -p <ttyd-pid>` shows `-T xterm-256color-weave`;
`infocmp xterm-256color-weave` shows `bce` present + `csr` absent; `tmux list-clients
-t weave-<id> -F '#{client_termname}'` shows the sentinel once a browser connects.

## The resize / re-fit model (misalignment)

A terminal iframe opens its WebSocket on load **even while its tab is hidden**;
`safeFit()` no-ops at 0×0, so the handshake sends xterm's default **80×24** and
tmux/vim start there. Fix: `activate()` in `terminal.js` posts `{type:"weave-activate"}`
to the now-visible iframe; `terminal-xterm.js` re-fits (fires `onResize → sendResize`,
correcting the PTY) then repaints. `window-size latest` makes tmux honor the browser
client's size. Tell-tale of the un-fixed bug: `tmux list-clients` shows sessions
stuck at `80x24` while active ones are larger.

## Recovery levers (force redraw)

- **⟳ toolbar button** (`terminal.html` `#term-redraw` → `redrawActive()` in `terminal.js`): posts `weave-redraw` to the client (`repaint()` = `clearTextureAtlas()` + `refresh()`) AND `POST /api/terminals/:id/redraw` → `refreshSession()` → `tmux refresh-client` (re-sends the whole screen, repairs holes tmux believes it already sent).
- The client also auto-repaints on wheel-settle, window focus, ResizeObserver settle, and scheme change.

## Fallbacks (if TERM + resize fixes aren't enough)

- **WebGL renderer, active-only** — swap CanvasAddon for `@xterm/addon-webgl`, attach only to the visible iframe and `dispose()` on hide (browsers cap ~16 live WebGL2 contexts). Needs the addon vendored (a download → ask first).
- **Drop tmux for `dtach`/`abduco`** — transparent byte-passthrough persistence; kills the whole tmux re-render class but loses copy-mode / status line / `send-keys` injection (a real rework) and is a `brew install`.
- **mvim / native-editor escape hatch** — `server.ts buildOpenCommand` already prefers `mvim` when present; a bail-out for editing, not a terminal fix.

## Key files

- `.weave/lib/terminals.ts` — `ttydTerm()`, `ensureWeaveTerminfo()`, `WEAVE_TERM`, `applySessionOptions()`, `refreshSession()`.
- `.weave/public/terminal-xterm.js` — Terminal construction, CanvasAddon, `safeFit()`, `repaint()`, the `message` listener, `term.write` (the byte-capture point).
- `.weave/public/terminal.js` — `activate()` (posts `weave-activate`), `redrawActive()`.
- `.weave/server.ts` — the `/api/terminals/:id/redraw` route, `buildOpenCommand` (mvim).

## Prerequisites

- `ttyd`, `tmux`, and a terminfo compiler (`tic`) on PATH; `tmux-256color` + `xterm-256color` terminfo present (macOS ships both).
- The dashboard runs via `bun --hot`, so backend edits hot-reload; client JS/HTML changes need a browser refresh, and existing sessions need a ttyd respawn (close+reopen the tab, or restart the dashboard) to pick up a new TERM.
