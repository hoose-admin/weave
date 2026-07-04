// Terminal color schemes — the single source of truth for the embedded
// xterm.js terminal's palette.
//
// This is a browser terminal (xterm.js in an iframe), NOT your native
// iTerm2/Ghostty, so none of your local terminal's colors apply. The look is
// entirely weave's own, and these schemes are it.
//
// Loaded as a CLASSIC script (sets a window global) in BOTH:
//   • terminal.html       — the dashboard page; terminal.js reads {id,label}
//                           to build the scheme <select>.
//   • terminal-xterm.html — the framed client; terminal-xterm.js reads `theme`
//                           and hands it straight to xterm.
// One file, two readers — so a scheme's name and its colors never drift apart.
//
// Each `theme` is a COMPLETE xterm.js ITheme: the surface (background /
// foreground / cursor / selection) AND the full 16-color ANSI palette. That's
// the upgrade over the old behavior, which set only the surface and left the
// ANSI 16 (the red/green/blue of `ls`, `git`, Claude Code output) at xterm's
// generic defaults.
//
// Schemes are SELF-CONTAINED and FIXED — each one is its own light or dark.
// They do NOT follow the dashboard's light/dark toggle: the user picks a scheme
// directly and it stays put. (This is why terminal-xterm.js no longer reads the
// `weave-theme` key.) Palettes are the upstream/canonical values for each.

(function () {
    const SCHEMES = {
        evening: {
            // Vim's built-in `evening` colorscheme (dark grey background).
            // Surface = Normal/Cursor/Visual; the 16 ANSI colors are lifted
            // verbatim from evening.vim's own `g:terminal_ansi_colors`.
            label: "Evening (vim)",
            theme: {
                background: "#333333",
                foreground: "#ffffff",
                cursor: "#00ff00",
                cursorAccent: "#000000",
                selectionBackground: "rgba(153,153,153,0.5)",
                black: "#000000",
                red: "#cd0000",
                green: "#00cd00",
                yellow: "#cdcd00",
                blue: "#0087ff",
                magenta: "#cd00cd",
                cyan: "#00cdcd",
                white: "#e5e5e5",
                brightBlack: "#7f7f7f",
                brightRed: "#ff0000",
                brightGreen: "#00ff00",
                brightYellow: "#ffff00",
                brightBlue: "#5c5cff",
                brightMagenta: "#ff00ff",
                brightCyan: "#00ffff",
                brightWhite: "#ffffff",
            },
        },
        "github-dark": {
            label: "GitHub Dark",
            theme: {
                background: "#0d1117",
                foreground: "#c9d1d9",
                cursor: "#c9d1d9",
                cursorAccent: "#0d1117",
                selectionBackground: "rgba(56,139,253,0.4)",
                black: "#484f58",
                red: "#ff7b72",
                green: "#3fb950",
                yellow: "#d29922",
                blue: "#58a6ff",
                magenta: "#bc8cff",
                cyan: "#39c5cf",
                white: "#b1bac4",
                brightBlack: "#6e7681",
                brightRed: "#ffa198",
                brightGreen: "#56d364",
                brightYellow: "#e3b341",
                brightBlue: "#79c0ff",
                brightMagenta: "#d2a8ff",
                brightCyan: "#56d4dd",
                brightWhite: "#f0f6fc",
            },
        },
        "catppuccin-mocha": {
            label: "Catppuccin Mocha",
            theme: {
                background: "#1e1e2e",
                foreground: "#cdd6f4",
                cursor: "#f5e0dc",
                cursorAccent: "#1e1e2e",
                selectionBackground: "rgba(88,91,112,0.5)",
                black: "#45475a",
                red: "#f38ba8",
                green: "#a6e3a1",
                yellow: "#f9e2af",
                blue: "#89b4fa",
                magenta: "#f5c2e7",
                cyan: "#94e2d5",
                white: "#bac2de",
                brightBlack: "#585b70",
                brightRed: "#f38ba8",
                brightGreen: "#a6e3a1",
                brightYellow: "#f9e2af",
                brightBlue: "#89b4fa",
                brightMagenta: "#f5c2e7",
                brightCyan: "#94e2d5",
                brightWhite: "#a6adc8",
            },
        },
        dracula: {
            label: "Dracula",
            theme: {
                background: "#282a36",
                foreground: "#f8f8f2",
                cursor: "#f8f8f2",
                cursorAccent: "#282a36",
                selectionBackground: "rgba(68,71,90,0.6)",
                black: "#21222c",
                red: "#ff5555",
                green: "#50fa7b",
                yellow: "#f1fa8c",
                blue: "#bd93f9",
                magenta: "#ff79c6",
                cyan: "#8be9fd",
                white: "#f8f8f2",
                brightBlack: "#6272a4",
                brightRed: "#ff6e6e",
                brightGreen: "#69ff94",
                brightYellow: "#ffffa5",
                brightBlue: "#d6acff",
                brightMagenta: "#ff92df",
                brightCyan: "#a4ffff",
                brightWhite: "#ffffff",
            },
        },
        nord: {
            label: "Nord",
            theme: {
                background: "#2e3440",
                foreground: "#d8dee9",
                cursor: "#d8dee9",
                cursorAccent: "#2e3440",
                selectionBackground: "rgba(67,76,94,0.6)",
                black: "#3b4252",
                red: "#bf616a",
                green: "#a3be8c",
                yellow: "#ebcb8b",
                blue: "#81a1c1",
                magenta: "#b48ead",
                cyan: "#88c0d0",
                white: "#e5e9f0",
                brightBlack: "#4c566a",
                brightRed: "#bf616a",
                brightGreen: "#a3be8c",
                brightYellow: "#ebcb8b",
                brightBlue: "#81a1c1",
                brightMagenta: "#b48ead",
                brightCyan: "#8fbcbb",
                brightWhite: "#eceff4",
            },
        },
        "gruvbox-dark": {
            // Standard Gruvbox dark (medium contrast) palette.
            label: "Gruvbox Dark",
            theme: {
                background: "#282828",
                foreground: "#ebdbb2",
                cursor: "#fe8019",
                cursorAccent: "#282828",
                selectionBackground: "rgba(80,73,69,0.6)",
                black: "#282828",
                red: "#cc241d",
                green: "#98971a",
                yellow: "#d79921",
                blue: "#458588",
                magenta: "#b16286",
                cyan: "#689d6a",
                white: "#a89984",
                brightBlack: "#928374",
                brightRed: "#fb4934",
                brightGreen: "#b8bb26",
                brightYellow: "#fabd2f",
                brightBlue: "#83a598",
                brightMagenta: "#d3869b",
                brightCyan: "#8ec07c",
                brightWhite: "#ebdbb2",
            },
        },
        "desert-evening": {
            // Anthropic brand palette. Background/salmon/grey/teal/blue are
            // exact RGB values measured off the real Claude Code UI:
            //   salmon 204,139,137 · grey 148,148,148 · bg 51,51,51
            //   teal 93,202,203 · blue 183,214,251
            // green/yellow/magenta aren't part of that measured set — they're
            // carried over from other accent hexes found in the CLI binary
            // (#558A42 green, #eab308/#fbbf24 yellow, #6437e3/#8b5cf6 magenta)
            // to fill out a usable 16-color ANSI ramp.
            label: "Desert Evening",
            theme: {
                background: "#333333",
                foreground: "#ffffff",
                cursor: "#cc8b89",
                cursorAccent: "#333333",
                selectionBackground: "rgba(148,148,148,0.35)",
                black: "#333333",
                red: "#cc8b89",
                green: "#a7cd98",
                yellow: "#eab308",
                blue: "#b7d6fb",
                magenta: "#6437e3",
                cyan: "#5dcacb",
                white: "#ffffff",
                brightBlack: "#949494",
                brightRed: "#ff9999",
                brightGreen: "#97c587",
                brightYellow: "#fbbf24",
                brightBlue: "#b7d6fb",
                brightMagenta: "#8b5cf6",
                brightCyan: "#5dcacb",
                brightWhite: "#ffffff",
            },
        },
        "solarized-dark": {
            label: "Solarized Dark",
            theme: {
                background: "#002b36",
                foreground: "#839496",
                cursor: "#839496",
                cursorAccent: "#002b36",
                selectionBackground: "rgba(7,54,66,0.8)",
                black: "#073642",
                red: "#dc322f",
                green: "#859900",
                yellow: "#b58900",
                blue: "#268bd2",
                magenta: "#d33682",
                cyan: "#2aa198",
                white: "#eee8d5",
                brightBlack: "#002b36",
                brightRed: "#cb4b16",
                brightGreen: "#586e75",
                brightYellow: "#657b83",
                brightBlue: "#839496",
                brightMagenta: "#6c71c4",
                brightCyan: "#93a1a1",
                brightWhite: "#fdf6e3",
            },
        },
    };

    const DEFAULT = "evening";

    window.WEAVE_TERM_SCHEMES = SCHEMES;
    window.WEAVE_TERM_SCHEME_DEFAULT = DEFAULT;
    window.WEAVE_TERM_SCHEME_KEY = "weave-term-scheme";

    // Resolve any stored value (possibly null, or a stale id) to a valid scheme
    // id. Both readers funnel through this so an unknown id can never throw.
    window.weaveTermScheme = function (id) {
        return Object.prototype.hasOwnProperty.call(SCHEMES, id) ? id : DEFAULT;
    };
})();
