-- weave-vim-setup: managed neovim config (nvim is weave's default editor).
-- Delete this marker line to take ownership; weave will then stop refreshing this file.

-- 1. Install lazy.nvim automatically
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not vim.loop.fs_stat(lazypath) then
  vim.fn.system({ "git", "clone", "--filter=blob:none", "https://github.com/folke/lazy.nvim.git", lazypath })
end
vim.opt.rtp:prepend(lazypath)

-- 2. Plugin Setup
require("lazy").setup({
  -- File Explorer
  { "nvim-neo-tree/neo-tree.nvim", dependencies = { "nvim-lua/plenary.nvim", "MunifTanjim/nui.nvim", "nvim-tree/nvim-web-devicons" } },

  -- Git Signs
  { "lewis6991/gitsigns.nvim", config = true },

  -- Color Themes (Nord is the default; the others are available via :colorscheme / <leader>ut)
  { "shaunsingh/nord.nvim", priority = 1000, config = function()
      vim.cmd.colorscheme("nord")
    end },
  { "catppuccin/nvim", name = "catppuccin", lazy = false },
  { "folke/tokyonight.nvim", lazy = false },
  { "ellisonleao/gruvbox.nvim", lazy = false },
})

-- 3. Keybindings
-- Toggle Neo-tree with <leader>e
vim.keymap.set('n', '<leader>e', ':Neotree toggle<CR>')

-- Git Signs: navigate hunks + view changes inline (GitHub-style red/green in the buffer)
vim.keymap.set('n', ']h', ':Gitsigns next_hunk<CR>')
vim.keymap.set('n', '[h', ':Gitsigns prev_hunk<CR>')
vim.keymap.set('n', '<leader>gp', ':Gitsigns preview_hunk_inline<CR>')  -- expand this hunk inline (red removed / green added)
vim.keymap.set('n', '<leader>gb', ':Gitsigns blame_line<CR>')           -- who/when changed this line
vim.keymap.set('n', '<leader>gD', ':Gitsigns diffthis<CR>')             -- full-file split diff vs index

-- <leader>gd toggles a persistent GitHub-style inline diff: green added/changed lines,
-- red removed lines shown inline, and word-level highlights within changed lines.
local gitdiff_on = false
vim.keymap.set('n', '<leader>gd', function()
  local gs = require('gitsigns')
  gitdiff_on = not gitdiff_on
  gs.toggle_linehl(gitdiff_on)     -- full-line background: added/changed green, removed red
  gs.toggle_word_diff(gitdiff_on)  -- highlight the exact changed words
  gs.toggle_deleted(gitdiff_on)    -- render removed lines inline (red virtual lines)
end, { desc = 'Toggle GitHub-style inline git diff' })

-- 4. Command-line autocomplete (wildmenu)
-- In command mode, <Tab> completes + cycles through matches (e.g. `:colorscheme <Tab>`).
vim.opt.wildmenu = true                     -- on by default in nvim; set explicitly
vim.opt.wildmode = "longest:full,full"      -- 1st Tab: longest match + open menu; then cycle
vim.opt.wildoptions = "pum"                 -- show completions as a vertical popup menu

-- 5. Theme switcher — <leader>ut opens a picker of installed colorschemes
local themes = {
  "nord",
  "catppuccin-mocha", "catppuccin-macchiato", "catppuccin-frappe", "catppuccin-latte",
  "tokyonight", "tokyonight-storm", "tokyonight-night", "tokyonight-day",
  "gruvbox",
}
vim.keymap.set('n', '<leader>ut', function()
  vim.ui.select(themes, { prompt = "Colorscheme:" }, function(choice)
    if choice then vim.cmd.colorscheme(choice) end
  end)
end, { desc = "Theme switcher" })
