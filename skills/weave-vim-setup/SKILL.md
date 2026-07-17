---
name: weave-vim-setup
description: "Idempotently sets up the terminal editors for the weave workflow. NEOVIM is weave's DEFAULT editor (.weave/server.ts click-to-open prefers nvim): writes a managed ~/.config/nvim/init.lua with lazy.nvim + neo-tree (file browser), gitsigns (git diff signs), nord as the default colorscheme plus catppuccin/tokyonight/gruvbox, a <leader>ut theme switcher, and popup command-line completion; plugins install on first launch (and eagerly during setup). VIM is the fallback: ~/.vimrc gets syntax on + the built-in `evening` colorscheme (matches MacVim/mvim) and vim-signify auto-loaded from the native pack `start/` dir for a git diff gutter, configured `g:signify_realtime = 0` so signs refresh only on write/BufEnter — no as-you-type churn — keeping it safe for the weave terminal. Runs a bundled shell script; safe to re-run; skips each editor cleanly when its binary is absent; never clobbers a hand-owned init.lua. Downloads plugins from GitHub on first run only."
when_to_use: "User says 'set up vim/nvim for weave', 'install neovim for weave', 'set up the weave editor', 'make nvim the default editor', 'install vim-signify', 'make terminal vim/nvim show git hunks / a diff gutter', 'my diff gutter / signify isn't showing changes', 'why are there no colors in terminal vim', 'add a file browser / git signs / themes to nvim', or 'match mvim colors in plain vim'. Also invoked by the weave installer (setup.sh) on install of the weave repo into a project — headless via `claude -p \"/weave-vim-setup\"`, or by calling the bundled scripts/install.sh directly from setup."
connects_to: []
kind: action
---

# Weave Vim/Nvim Setup

Configures the terminal editors weave can open — in one idempotent step.

**Neovim is weave's default editor** (`.weave/server.ts:buildOpenCommand` opens a
clicked file with `nvim` when present, then `mvim`, then `vim`). The script writes
a managed `~/.config/nvim/init.lua` with lazy.nvim + **neo-tree** (file browser,
`<leader>e`), **gitsigns** (git diff signs, `]h`/`[h`), **nord** as the default
colorscheme plus catppuccin/tokyonight/gruvbox, a `<leader>ut` theme switcher, and
popup command-line completion (`:colorscheme <Tab>`). Plugins install on first
launch and eagerly during setup.

**Vim is the fallback:** a `~/.vimrc` block that turns on syntax highlighting and
the `evening` colorscheme (so terminal vim looks like MacVim/mvim), plus
vim-signify installed to the pack `start/` dir (auto-loaded) for git diff signs.

Produces a managed `~/.config/nvim/init.lua`, a modified `~/.vim/pack/...` and
`~/.vimrc`; prints what it changed vs skipped. Never clobbers a hand-owned
`init.lua` (one without the `weave-vim-setup: managed neovim config` marker).

**Hand-owned drift:** when you add a feature to the template `scripts/nvim/init.lua`,
a user whose live `~/.config/nvim/init.lua` is hand-owned (marker removed) will NOT
receive it — `install.sh` prints `exists and is hand-owned (skip)` and leaves the file
alone. Editing the template is not enough. Read their live config, confirm the feature's
plugin is present, then apply the delta **directly** to `~/.config/nvim/init.lua` as an
additive edit (never re-add the marker on their behalf — that silently re-arms clobber).

## Weave-terminal rendering constraint (read this)

The weave terminal (ttyd + tmux) **disables the scroll region on purpose** (the
`xterm-256color-weave` terminfo) to stop vim redraw artifacts. Anything that
drives frequent full/partial redraws re-corrupts it. That is why the diff-gutter
plugin here is **vim-signify with `g:signify_realtime = 0`**:

- signify recomputes signs **only on write/BufEnter**, not on every keystroke —
  no continuous redraw churn — so it is safe to **auto-load from `start/`**;
- this is the key difference from the old vim-gitgutter setup, whose
  low-`updatetime` refresh was the churn source that corrupted rendering (so it
  had to live in `opt/`, off by default). Signify with realtime off does not.

Do **not** set `let g:signify_realtime = 1` and do **not** lower `updatetime`
for the weave terminal — either reintroduces the churn. Signs appearing only
after `:w` is expected and intended.

## When to invoke

- "set up the weave editor" / "set up nvim/vim for weave" / "make nvim the default editor" → run `scripts/install.sh`
- "add a file browser / git signs / themes to nvim" → run `scripts/install.sh`
- "why no colors in terminal vim" / "match mvim colors" → run `scripts/install.sh`
- "make terminal vim/nvim show git hunks / a diff gutter" → run `scripts/install.sh`
- "signify / the diff gutter isn't showing my changes" (vim) → run `scripts/install.sh` (it usually means the plugin was never installed — the `.vimrc` had signify config but no plugin in pack `start/`)
- weave installer → `setup.sh` calls `scripts/install.sh` directly, or `claude -p "/weave-vim-setup"`

## When NOT to invoke

- The weave *dashboard* terminal itself (ttyd/dtach/xterm.js render stack) — that's `weave-terminal`. This skill only touches the user's editor config (`~/.config/nvim`, `~/.vimrc`, the vim pack dir).
- Editing project code, or editor options unrelated to the file browser / git signs / colors.
- Changing which editor `.weave/server.ts` opens — that binary preference lives in `buildOpenCommand` (a `.weave` change, backported via `weave-sync`), not in this skill's install script.

## Procedure

The work is deterministic — delegate to the bundled script, don't hand-roll the steps.

1. **Run the installer** — `bash ${CLAUDE_SKILL_DIR}/scripts/install.sh`. It runs `setup_nvim` then `setup_vim`; idempotent and self-reporting; re-running is safe.
2. **What `setup_nvim` does** (weave's default editor) — if `nvim` is on PATH, copies the managed `scripts/nvim/init.lua` to `~/.config/nvim/init.lua` (lazy.nvim + neo-tree + gitsigns + nord/themes + `<leader>ut` switcher + popup completion), then eagerly installs the plugins with `nvim --headless "+Lazy! sync" +qa`. A hand-owned `init.lua` (no `weave-vim-setup: managed neovim config` marker) is left untouched; a previously-managed one is refreshed.
3. **What `setup_vim` does** (fallback) — (a) clones `mhinz/vim-signify` into `~/.vim/pack/mhinz/start/vim-signify` only if absent (`start/` = auto-loaded), then rebuilds helptags; (b) writes a marker-delimited managed block to `~/.vimrc` with the colors fix (`syntax on`, `colorscheme evening`) **and** the terminal-safe signify config (`set signcolumn=yes`, `let g:signify_realtime = 0`, `let g:signify_vcs_list = ['git']`). Self-migrating: a stale block is stripped and re-appended. Hand-configured signify outside the markers is left untouched.
4. **First-run download** — cloning lazy.nvim + the nvim plugins (and vim-signify) is a network op (gated by `CLAUDE.md`). When invoked interactively, confirm before the first run. On second+ runs nothing new is downloaded.
5. **Report** — relay the script's skip/change lines. Tell the user: clicking a file in the weave terminal now opens **nvim** (file browser `<leader>e`, git signs `]h`/`[h`, nord theme, `<leader>ut` to switch); vim (the fallback) matches mvim colors and shows signify signs after `:w`.

## Prerequisites

- `git` on PATH. `nvim` (0.9+) and/or `vim` (8.0+) — each editor's setup is skipped (exit 0, skip notice) when its binary is absent. The script does **not** install the editor binaries; if `nvim` is missing it prints an `install neovim` hint.
- Network access on the **first** run only (to clone lazy.nvim + the nvim plugins, and vim-signify).

## Background

- **nvim is weave's default editor.** `.weave/server.ts:buildOpenCommand` (the terminal Search tab's click-to-open) resolves the editor as `nvim` → `mvim` → `vim`, probing `Bun.which` plus the usual Homebrew/local paths. The nvim config is a whole managed file (not a marker block inside a user file, the way `~/.vimrc` is), because `init.lua` is normally the entire config — so the marker is a single top comment line and "hand-owned" = that line absent.
- **nvim plugins**: neo-tree (file browser, `<leader>e`), gitsigns (git diff signs, `]h`/`[h`), nord (default) + catppuccin/tokyonight/gruvbox switchable via `<leader>ut` or `:colorscheme <Tab>` (popup completion via `wildoptions=pum`). These render fine in the current weave terminal (ttyd→dtach→xterm.js: dtach passes the app's real escapes straight through — the tmux-era redraw churn that forced vim's signify to `realtime=0` no longer sits in the render path).
- **`syntax on`** is the colors fix: MacVim's bundled gvimrc runs `syntax on` automatically, but terminal vim does not when a user `~/.vimrc` exists — so terminal vim looked colorless. `evening` is a built-in colorscheme (no download).
- **vim-signify** shows lines that differ from the git index as gutter signs — the "hunk"/diff view. It refreshes on write/BufEnter (never as-you-type, given `realtime = 0`), which is why it renders cleanly in the weave terminal where gitgutter did not.
- **Verifying it works** (headless): silent Ex mode suppresses signify's autocmds, so a bare `vim -es … sign place` shows nothing even when signify is fine. Instead force a compute and dump signs:
  `vim -N -u ~/.vimrc -c "silent! call sy#start()" -c "sleep 500m" -c "redir! > /tmp/sig.txt" -c "silent! sign place" -c "redir END" -c "qa!" <a-modified-tracked-file>` — expect `name=SignifyAdd/SignifyChange/SignifyDelete` lines.
- **Superseded gitgutter**: earlier versions of this skill installed vim-gitgutter to `opt/`. Signify replaces it. A leftover `~/.vim/pack/airblade/opt/vim-gitgutter` is inert (not auto-loaded) and harmless; remove it only if the user asks.

## References

- `${CLAUDE_SKILL_DIR}/scripts/install.sh` — the idempotent installer (`setup_nvim` + `setup_vim`). This is the single source of the install logic; do not duplicate its steps elsewhere.
- `${CLAUDE_SKILL_DIR}/scripts/nvim/init.lua` — the managed neovim config template copied to `~/.config/nvim/init.lua`. Edit the config here (keep the marker line first), not in the user's home.
- `.weave/server.ts:buildOpenCommand` — where the default-editor preference (`nvim` → `mvim` → `vim`) lives. Changing it is a `.weave` edit backported via `weave-sync`, not part of this skill.
