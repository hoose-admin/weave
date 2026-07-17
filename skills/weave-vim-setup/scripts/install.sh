#!/usr/bin/env bash
# weave-vim-setup: terminal-safe editor setup for the weave terminal.
#
# Configures BOTH editors weave can open (see .weave/server.ts buildOpenCommand,
# which prefers nvim, then mvim, then vim):
#
#   NEOVIM — weave's DEFAULT editor. Writes ~/.config/nvim/init.lua with lazy.nvim
#     + neo-tree (file browser, <leader>e), gitsigns (git diff signs, ]h / [h),
#     nord (default colorscheme) + catppuccin/tokyonight/gruvbox, a <leader>ut theme
#     switcher, and popup command-line completion (:colorscheme <Tab>). Plugins
#     install on first launch (and eagerly here when nvim is present). A hand-owned
#     init.lua (one without our marker) is left untouched.
#
#   VIM — the fallback. Ensures ~/.vimrc turns on syntax highlighting + the built-in
#     `evening` colorscheme (matches MacVim/mvim), and installs vim-signify into the
#     native pack start/ dir (auto-loaded) for git diff signs in the gutter,
#     configured terminal-safe (realtime OFF — see WHY below).
#
# WHY signify AUTO-loads (unlike the old gitgutter setup, which was opt/-only):
# the weave terminal has its scroll region disabled on purpose to stop vim redraw
# artifacts, so anything driving continuous redraws re-corrupts it. vim-signify
# with `g:signify_realtime = 0` recomputes signs ONLY on write/BufEnter — no
# as-you-type churn — so it is terminal-safe to auto-load. (gitgutter's low
# `updatetime` refresh was the churn source that forced it off-by-default.)
#
# Safe to re-run. Skips cleanly when an editor is absent. Downloads plugins from
# GitHub on first run only (network op).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ============================ NEOVIM (weave default) =========================
setup_nvim() {
  if ! command -v nvim >/dev/null 2>&1; then
    echo "weave-vim-setup: nvim not found on PATH — skipping neovim setup."
    echo "                 install neovim (e.g. 'brew install neovim'), then re-run."
    return 0
  fi
  local template="${SCRIPT_DIR}/nvim/init.lua"
  local init="${HOME}/.config/nvim/init.lua"
  local marker="weave-vim-setup: managed neovim config"

  if [ ! -f "${template}" ]; then
    echo "weave-vim-setup: nvim template missing at ${template} (skip)."
    return 0
  fi
  # Never clobber a hand-owned init.lua (one WITHOUT our marker).
  if [ -f "${init}" ] && ! grep -qF "${marker}" "${init}"; then
    echo "weave-vim-setup: ~/.config/nvim/init.lua exists and is hand-owned (skip)."
    echo "                 to let weave manage it, remove it first, then re-run."
    return 0
  fi
  mkdir -p "$(dirname "${init}")"
  cp "${template}" "${init}"
  echo "weave-vim-setup: wrote managed neovim config -> ${init}"

  # Eagerly install plugins so the first real launch is instant (network op;
  # otherwise lazy.nvim installs them on first `nvim`). Non-fatal.
  echo "weave-vim-setup: installing neovim plugins (neo-tree, gitsigns, nord + themes)…"
  if nvim --headless "+Lazy! sync" +qa >/dev/null 2>&1; then
    echo "weave-vim-setup: neovim plugins installed."
  else
    echo "weave-vim-setup: plugin pre-install skipped — lazy.nvim will install them on first launch."
  fi
}

# ============================ VIM (fallback) =================================
setup_vim() {
  if ! command -v vim >/dev/null 2>&1; then
    echo "weave-vim-setup: vim not found on PATH — skipping vim setup."
    return 0
  fi
  local PLUGIN_DIR="${HOME}/.vim/pack/mhinz/start/vim-signify"
  local VIMRC="${HOME}/.vimrc"
  local MARK_BEGIN="\" >>> weave-vim-setup >>>"
  local MARK_END="\" <<< weave-vim-setup <<<"

  # 1. vim-signify into start/ (auto-loaded). Idempotent: clone only if absent.
  if [ -d "${PLUGIN_DIR}/.git" ] || [ -d "${PLUGIN_DIR}/plugin" ]; then
    echo "weave-vim-setup: vim-signify already present at ${PLUGIN_DIR} (skip)."
  else
    echo "weave-vim-setup: installing vim-signify -> ${PLUGIN_DIR} (start/, auto-loaded)"
    mkdir -p "$(dirname "${PLUGIN_DIR}")"
    git clone --depth 1 https://github.com/mhinz/vim-signify.git "${PLUGIN_DIR}"
  fi
  vim -u NONE -es -c "helptags ${PLUGIN_DIR}/doc" -c q >/dev/null 2>&1 || true

  # 2. ~/.vimrc: colors + terminal-safe signify config.
  #    - If signify is already configured OUTSIDE our markers (hand-rolled), leave
  #      it alone — the user owns that block.
  #    - Otherwise strip any stale managed block and append a fresh one (self-migrating).
  if [ -f "${VIMRC}" ] && grep -q "signify_realtime" "${VIMRC}" && ! grep -qF "${MARK_BEGIN}" "${VIMRC}"; then
    echo "weave-vim-setup: ~/.vimrc already has hand-written signify config (skip)."
  else
    if [ -f "${VIMRC}" ] && grep -qF "${MARK_BEGIN}" "${VIMRC}"; then
      local tmp; tmp="$(mktemp)"
      sed '/>>> weave-vim-setup >>>/,/<<< weave-vim-setup <<</d' "${VIMRC}" > "${tmp}" && mv "${tmp}" "${VIMRC}"
      echo "weave-vim-setup: refreshed existing managed block in ${VIMRC}"
    else
      echo "weave-vim-setup: appending managed block to ${VIMRC}"
    fi
    {
      printf '\n%s\n' "${MARK_BEGIN}"
      printf '%s\n' "\" Colors: match mvim (both built-in, no download)."
      printf 'syntax on\n'
      printf 'colorscheme evening\n'
      printf '%s\n' "\" vim-signify: git diff signs in the gutter. Auto-loaded from pack start/."
      printf '%s\n' "\" realtime OFF: as-you-type sign churn re-corrupts the weave/ttyd/tmux"
      printf '%s\n' "\" terminal (same reason gitgutter was opt-in). Signs refresh on write/BufEnter."
      printf 'set signcolumn=yes\n'
      printf 'let g:signify_realtime = 0\n'
      printf "let g:signify_vcs_list = ['git']\n"
      printf '%s\n' "${MARK_END}"
    } >> "${VIMRC}"
  fi
}

setup_nvim
setup_vim
echo "weave-vim-setup: done. nvim is weave's default editor (neo-tree + gitsigns + nord); vim is the fallback."
