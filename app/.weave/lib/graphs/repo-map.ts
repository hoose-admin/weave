// Generic, best-effort code-structure graph for the dashboard's
// /graphs/repo-map view.
//
// This is the FALLBACK builder. The `repo-map` skill writes a richer
// cache/repo-map-graph.json by introspecting the repo with an agent; when that
// cache is present the server serves it verbatim (see server.ts —
// newestSourceMtime returns 0 for repo-map, so a written cache always wins).
// When the cache is absent, this heuristic walks REPO_ROOT and emits a FLAT
// directory/file containment graph plus best-effort relative-import edges, so
// the view is never empty on a fresh install.
//
// FLAT on purpose (no compound `parent` nodes): the dashboard's default dagre
// layout throws on compound nodes. Directories are ordinary nodes linked to
// their children with `contains` edges. Cytoscape shape: { nodes, edges, meta }.

import { readdir, readFile } from "node:fs/promises";
import { join, relative, dirname, extname, normalize } from "node:path";
import { REPO_ROOT } from "../../weave.config.ts";

export type RepoMapNode = {
  data: { id: string; label: string; kind: "dir" | "file"; lang?: string; entry?: boolean };
};
export type RepoMapEdge = {
  data: { id: string; source: string; target: string; kind: "contains" | "imports" };
};
export type RepoMapGraph = {
  nodes: RepoMapNode[];
  edges: RepoMapEdge[];
  meta: {
    built: string;
    counts: Record<string, number>;
    warnings: { kind: string; detail: string }[];
    source: string;
  };
};

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".svelte-kit", "dist", "build", "out",
  "__pycache__", ".venv", "venv", ".turbo", "coverage", ".cache", "vendor",
  "target", ".idea", ".vscode", ".weave", ".pytest_cache", ".mypy_cache",
]);

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".py": "py", ".go": "go", ".rs": "rs", ".rb": "rb", ".java": "java",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
  ".cs": "cs", ".php": "php", ".swift": "swift", ".kt": "kt",
  ".scala": "scala", ".sh": "sh", ".sql": "sql", ".vue": "vue", ".svelte": "svelte",
};

const ENTRY_NAMES = new Set([
  "index.ts", "index.js", "main.ts", "main.js", "main.py", "__main__.py",
  "app.ts", "app.py", "server.ts", "main.go", "main.rs", "mod.rs", "lib.rs",
]);

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

const MAX_NODES = 600;
const MAX_EDGES = 2500;
const MAX_FILE_BYTES = 200_000;

function langFor(rel: string): string | undefined {
  return LANG_BY_EXT[extname(rel).toLowerCase()];
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name.startsWith(".")) continue; // skip hidden dirs/files (.git, .claude, .tickets, .weave …)
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        stack.push(join(dir, e.name));
      } else if (e.isFile() && langFor(e.name)) {
        out.push(relative(root, join(dir, e.name)));
      }
    }
  }
  return out;
}

function ancestorsOf(rel: string): string[] {
  const dirs: string[] = [];
  let d = dirname(rel);
  while (d && d !== "." && d !== "/") {
    dirs.push(d);
    d = dirname(d);
  }
  return dirs;
}

// Relative-import specs from file content. JS/TS specs are returned verbatim
// (e.g. "./foo"); Python relative imports are encoded as "py:<dots>:<module>".
function extractImports(rel: string, content: string): string[] {
  const lang = langFor(rel);
  const specs: string[] = [];
  if (lang === "ts" || lang === "js" || lang === "vue" || lang === "svelte") {
    const res = [
      /(?:import|export)\b[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/g,
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const re of res) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) specs.push(m[1]);
    }
    return specs.filter((s) => s.startsWith("."));
  }
  if (lang === "py") {
    const re = /^\s*from\s+(\.+)([\w.]*)\s+import\b/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) specs.push(`py:${m[1].length}:${m[2] ?? ""}`);
    return specs;
  }
  return [];
}

function resolveJs(fromRel: string, spec: string, files: Set<string>): string | null {
  const base = normalize(join(dirname(fromRel), spec));
  const cands: string[] = [];
  if (langFor(base)) cands.push(base);
  for (const ext of JS_EXTS) cands.push(base + ext);
  for (const ext of JS_EXTS) cands.push(join(base, "index" + ext));
  for (const c of cands) {
    const n = normalize(c);
    if (files.has(n)) return n;
  }
  return null;
}

function resolvePy(fromRel: string, dots: number, mod: string, files: Set<string>): string | null {
  // `from . import x`       → dots=1 → base = dir of the importing file
  // `from .foo import x`     → dots=1 → base/foo
  // `from ..foo.bar import`  → dots=2 → up one more, then foo/bar
  let base = dirname(fromRel);
  for (let i = 1; i < dots; i++) base = dirname(base);
  const modPath = mod ? mod.split(".").join("/") : "";
  const target = modPath ? join(base, modPath) : base;
  for (const c of [target + ".py", join(target, "__init__.py")]) {
    const n = normalize(c);
    if (files.has(n)) return n;
  }
  return null;
}

export async function buildRepoMapGraph(): Promise<RepoMapGraph> {
  const fileList = await walk(REPO_ROOT);
  const fileSet = new Set(fileList);
  const warnings: { kind: string; detail: string }[] = [];

  const dirSet = new Set<string>();
  for (const f of fileList) for (const d of ancestorsOf(f)) dirSet.add(d);

  const fileLevel = fileList.length + dirSet.size <= MAX_NODES;
  if (!fileLevel) {
    warnings.push({
      kind: "truncated",
      detail: `${fileList.length} files + ${dirSet.size} dirs exceed the ${MAX_NODES}-node cap — showing directory level only`,
    });
  }

  const nodes: RepoMapNode[] = [];
  const edges: RepoMapEdge[] = [];
  let ei = 0;
  const pushEdge = (source: string, target: string, kind: "contains" | "imports") => {
    if (edges.length >= MAX_EDGES) return;
    edges.push({ data: { id: `e${ei++}`, source, target, kind } });
  };

  // Directory nodes + dir → subdir containment.
  for (const d of dirSet) {
    nodes.push({ data: { id: `dir:${d}`, label: d.split("/").pop() || d, kind: "dir" } });
  }
  for (const d of dirSet) {
    const parent = dirname(d);
    if (parent && parent !== "." && dirSet.has(parent)) pushEdge(`dir:${parent}`, `dir:${d}`, "contains");
  }

  const langCount: Record<string, number> = {};
  for (const f of fileList) {
    const lang = langFor(f)!;
    langCount[lang] = (langCount[lang] ?? 0) + 1;
  }

  const resolveSpec = (fromRel: string, spec: string): string | null => {
    if (spec.startsWith("py:")) {
      const [, dotsStr, mod] = spec.split(":");
      return resolvePy(fromRel, Number(dotsStr), mod ?? "", fileSet);
    }
    return resolveJs(fromRel, spec, fileSet);
  };

  if (fileLevel) {
    for (const f of fileList) {
      const name = f.split("/").pop()!;
      nodes.push({
        data: {
          id: f,
          label: name,
          kind: "file",
          lang: langFor(f)!,
          ...(ENTRY_NAMES.has(name) ? { entry: true } : {}),
        },
      });
      const parent = dirname(f);
      if (parent && parent !== "." && dirSet.has(parent)) pushEdge(`dir:${parent}`, f, "contains");
    }
    for (const f of fileList) {
      let content: string;
      try {
        content = await readFile(join(REPO_ROOT, f), "utf8");
      } catch {
        continue;
      }
      if (content.length > MAX_FILE_BYTES) continue;
      for (const spec of extractImports(f, content)) {
        const target = resolveSpec(f, spec);
        if (target && target !== f) pushEdge(f, target, "imports");
      }
    }
  } else {
    // Directory-level aggregation: one imports edge per (fromDir → toDir) pair.
    const seen = new Set<string>();
    for (const f of fileList) {
      const fromDir = dirname(f);
      if (!dirSet.has(fromDir)) continue;
      let content: string;
      try {
        content = await readFile(join(REPO_ROOT, f), "utf8");
      } catch {
        continue;
      }
      if (content.length > MAX_FILE_BYTES) continue;
      for (const spec of extractImports(f, content)) {
        const target = resolveSpec(f, spec);
        if (!target) continue;
        const toDir = dirname(target);
        if (!dirSet.has(toDir) || toDir === fromDir) continue;
        const key = `${fromDir}→${toDir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pushEdge(`dir:${fromDir}`, `dir:${toDir}`, "imports");
      }
    }
  }

  const counts: Record<string, number> = {
    dirs: dirSet.size,
    files: fileLevel ? fileList.length : 0,
    totalFiles: fileList.length,
    imports: edges.filter((e) => e.data.kind === "imports").length,
    ...langCount,
  };

  return {
    nodes,
    edges,
    meta: { built: new Date().toISOString(), counts, warnings, source: "heuristic" },
  };
}
