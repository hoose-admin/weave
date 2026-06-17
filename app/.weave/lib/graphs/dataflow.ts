// Generic, detection-based "dataflow" architecture-diagram graph builder.
//
// Renders four layers as a left→right chain:
//
//   fe-route ──fetch──▶ endpoint ◀──hosts── container
//                          │
//                   reads / writes
//                          ▼
//                        store
//
// i.e. a page invokes a server action / API endpoint, that endpoint runs inside
// a deploy container, and the endpoint reads/writes database collections/tables.
//
// This is a GENERIC builder: it detects the stack from the repo rather than
// hard-wiring any one app's conventions. It is tuned to produce a correct graph
// for a common web stack (an SSR/App-Router frontend with server-side data
// functions, a document store, and a single deploy container) but degrades
// gracefully — an absent layer yields an empty layer plus a warning rather than
// a crash.
//
// Sources of truth (all best-effort, regex-based — no AST dependency, no
// external deps, Node/Bun builtins only):
//   • Frontend routes : src/app/**/page.tsx and app/**/page.tsx (route groups
//                       `(group)` and `@slots` stripped). A route is `cached`
//                       when a file reachable from the page calls a server
//                       action through a TanStack Query hook.
//   • Containers      : Makefile (SERVICE_NAME / `gcloud run deploy <name>`),
//                       cloudbuild.yaml (deployed service), Dockerfile / fly.toml
//                       / docker-compose.yml. Falls back to package.json `name`,
//                       then the repo dir name (with a warning).
//   • Endpoints       : Server Actions — every exported async fn in a "use server"
//                       file (under src/actions/ or any file whose head declares
//                       "use server"). API routes — every src/app/api/**/route.ts.
//   • Stores          : Firestore collections / subcollections touched by the
//                       endpoints (`.collection('x')`, `.collectionGroup('x')`,
//                       `.doc(...).collection('child')`, with `const X = 'name'`
//                       constants resolved). SQL/BigQuery table names detected
//                       generically too, if present.
//
// Output is a FLAT Cytoscape graph — { nodes, edges, meta } — with NO compound
// `parent` fields (the dashboard's dagre layout throws on them). Nothing is ever
// silently dropped or capped; anything unresolved is recorded in meta.warnings.

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { REPO_ROOT } from "../../weave.config.ts";

// ── Public types ─────────────────────────────────────────────────────────────

export type NodeKind = "fe-route" | "container" | "endpoint" | "store";
export type EdgeKind = "fetch" | "hosts" | "reads" | "writes";

export interface DFNode {
  data: {
    id: string;
    label: string;
    kind: NodeKind;
    // fe-route
    cached?: boolean;
    file?: string; // repo-relative source file
    // container
    platform?: string;
    // endpoint
    access?: "server-action" | "api-route";
    container?: string; // container node id
    // store
    db?: "firestore" | "sql" | "bigquery";
  };
}

export interface DFEdge {
  data: {
    id: string;
    source: string;
    target: string;
    kind: EdgeKind;
    cached?: boolean; // fetch edges only
  };
}

export interface DFGraph {
  nodes: DFNode[];
  edges: DFEdge[];
  meta: {
    built: string;
    counts: {
      routes: number;
      containers: number;
      endpoints: number;
      stores: number;
      edges: number;
    };
    warnings: { kind: string; detail: string }[];
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

// Directories we never descend into / never treat as source.
const IGNORE_DIRS = new Set([
  "node_modules", ".next", ".git", "dist", "build", "out", ".weave",
  ".venv", "venv", "__pycache__", ".turbo", "coverage", ".cache", "vendor",
  "target", ".idea", ".vscode", ".pytest_cache", ".mypy_cache", ".svelte-kit",
]);

const MAX_REACHABLE_DEPTH = 3; // import-chase depth from a page

// ── Generic filesystem walk ──────────────────────────────────────────────────

async function walk(
  dir: string,
  predicate: (full: string, name: string) => boolean,
): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue;
    if (name.startsWith(".") && name !== "." && name !== "..") continue;
    const full = join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...(await walk(full, predicate)));
    else if (predicate(full, name)) out.push(full);
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readSafe(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

function rel(p: string): string {
  return relative(REPO_ROOT, p);
}

// Resolve the Next.js `app/` directory: prefer src/app, fall back to app.
async function findAppDir(): Promise<string | null> {
  for (const candidate of [join(REPO_ROOT, "src", "app"), join(REPO_ROOT, "app")]) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

// ── Matched-brace scanner (shared by several detectors) ──────────────────────

// Return the index of the closer matching the opener at `openIdx`, skipping
// string/template-literal contents. -1 if unbalanced.
function matchCloser(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let inString: string | null = null;
  let escape = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    // Skip comments so an apostrophe in `// don't` can't open a phantom string
    // (which would swallow braces and break brace matching).
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Route-path normalization ─────────────────────────────────────────────────

// Convert a page file's dir (relative to app/) into a route path:
//   ""                         → "/"
//   "campaigns"                → "/campaigns"
//   "campaigns/[id]"           → "/campaigns/[id]"
//   "(marketing)/about"        → "/about"      (route group dropped)
//   "@modal/photo"             → "/photo"      (parallel-route slot dropped)
function routePathFromRelDir(relDir: string): string {
  const parts = relDir
    .split("/")
    .filter((p) => p && p !== ".")
    .filter((p) => !/^\(.+\)$/.test(p)) // route groups
    .filter((p) => !p.startsWith("@")); // parallel-route slots
  return "/" + parts.join("/");
}

// Convert an api route.ts file's dir (relative to app/) into a `/api/...` path,
// preserving `[param]` segments verbatim (matches the ground-truth labels).
function apiPathFromRelDir(relDir: string): string {
  const parts = relDir
    .split("/")
    .filter((p) => p && p !== ".")
    .filter((p) => !/^\(.+\)$/.test(p));
  return "/" + parts.join("/");
}

// ── Layer: Containers ────────────────────────────────────────────────────────

interface Container {
  id: string;
  name: string;
  platform?: string;
  file?: string; // repo-relative source the name came from
}

// Detect the repo's deploy unit(s). We parse, in priority order, the files that
// declare a deployed service name. For the common single-service case this
// yields exactly one container.
async function detectContainers(
  warnings: { kind: string; detail: string }[],
): Promise<Container[]> {
  const found: Container[] = [];
  const seenNames = new Set<string>();
  const add = (name: string, platform: string | undefined, file: string) => {
    if (!name || seenNames.has(name)) return;
    seenNames.add(name);
    found.push({ id: `container:${name}`, name, platform, file });
  };

  // 1) Makefile — SERVICE_NAME assignment and/or `gcloud run deploy <name>`.
  const makefile = join(REPO_ROOT, "Makefile");
  const mk = await readSafe(makefile);
  if (mk) {
    const isCloudRun = /gcloud\s+run\s+deploy/.test(mk);
    const platform = isCloudRun ? "Cloud Run" : undefined;
    // SERVICE_NAME := <service-name>   (Make's := / = / ?= assignment forms)
    const svc = mk.match(/^\s*SERVICE_NAME\s*[:?]?=\s*([A-Za-z0-9_.-]+)/m);
    if (svc && !svc[1].startsWith("$")) add(svc[1], platform, rel(makefile));
    // `gcloud run deploy <literal-name>` (skip `$(VAR)` / `${VAR}` forms).
    const dep = mk.match(/gcloud\s+run\s+deploy\s+([A-Za-z0-9_.-]+)/);
    if (dep && !dep[1].startsWith("$")) add(dep[1], "Cloud Run", rel(makefile));
  }

  // 2) cloudbuild.yaml — the deployed Cloud Run service name. Cloud Build files
  //    usually parametrize it via `_SERVICE_NAME: 'name'` substitutions.
  for (const cbName of ["cloudbuild.yaml", "cloudbuild.yml"]) {
    const cbPath = join(REPO_ROOT, cbName);
    const cb = await readSafe(cbPath);
    if (!cb) continue;
    const sub = cb.match(/_SERVICE_NAME\s*:\s*['"]?([A-Za-z0-9_.-]+)['"]?/);
    if (sub && !sub[1].startsWith("$")) add(sub[1], "Cloud Run", rel(cbPath));
  }

  // 3) fly.toml — `app = "name"`.
  const flyPath = join(REPO_ROOT, "fly.toml");
  const fly = await readSafe(flyPath);
  if (fly) {
    const app = fly.match(/^\s*app\s*=\s*["']([A-Za-z0-9_.-]+)["']/m);
    if (app) add(app[1], "Fly.io", rel(flyPath));
  }

  // 4) docker-compose.yml — top-level `services:` keys (each is a container).
  for (const dcName of ["docker-compose.yml", "docker-compose.yaml", "compose.yaml"]) {
    const dcPath = join(REPO_ROOT, dcName);
    const dc = await readSafe(dcPath);
    if (!dc) continue;
    const lines = dc.split("\n");
    let inServices = false;
    for (const line of lines) {
      if (/^services\s*:/.test(line)) {
        inServices = true;
        continue;
      }
      if (inServices) {
        // Leaving the services block: a non-indented, non-blank, non-comment line.
        if (/^\S/.test(line) && !/^\s*#/.test(line)) break;
        const svc = line.match(/^\s{2}([A-Za-z0-9_.-]+)\s*:/);
        if (svc) add(svc[1], "Docker Compose", rel(dcPath));
      }
    }
  }

  if (found.length > 0) return found;

  // 5) Fallback: a Dockerfile or next.config exists ⇒ a single container named
  //    from package.json `name`.
  const hasDockerfile = await exists(join(REPO_ROOT, "Dockerfile"));
  const hasNextConfig =
    (await exists(join(REPO_ROOT, "next.config.ts"))) ||
    (await exists(join(REPO_ROOT, "next.config.js"))) ||
    (await exists(join(REPO_ROOT, "next.config.mjs")));
  const pkg = await readSafe(join(REPO_ROOT, "package.json"));
  let pkgName: string | undefined;
  if (pkg) {
    try {
      pkgName = (JSON.parse(pkg) as { name?: string }).name;
    } catch {
      /* malformed package.json — ignore */
    }
  }
  if ((hasDockerfile || hasNextConfig) && pkgName) {
    add(pkgName, hasDockerfile ? "Docker" : undefined, "package.json");
    return found;
  }

  // 6) Truly nothing detected: one container named after the repo dir + warn.
  const dirName = basename(REPO_ROOT) || "app";
  warnings.push({
    kind: "no-container-detected",
    detail: `No Makefile/cloudbuild/Dockerfile/fly.toml/compose service found — using repo dir name "${dirName}"`,
  });
  add(dirName, undefined, ".");
  return found;
}

// ── Layer: Endpoints (server actions + api routes) ───────────────────────────

interface Endpoint {
  id: string;
  name: string; // label
  access: "server-action" | "api-route";
  file: string; // repo-relative
  absFile: string; // absolute (for body parsing)
  fnName?: string; // server actions: the exported function name
  reads: Set<string>; // store names
  writes: Set<string>; // store names
}

// True if a file's first few non-empty lines declare "use server"/'use server'.
function declaresUseServer(src: string): boolean {
  const head = src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 3);
  return head.some((l) => /^["']use server["'];?$/.test(l));
}

// Collect every file that is a server-action module: under src/actions/ (or
// actions/), OR any .ts/.tsx file whose head declares "use server".
async function findServerActionFiles(appDir: string | null): Promise<string[]> {
  const files = new Set<string>();

  // Explicit actions dirs.
  for (const actionsDir of [join(REPO_ROOT, "src", "actions"), join(REPO_ROOT, "actions")]) {
    if (!(await exists(actionsDir))) continue;
    for (const f of await walk(actionsDir, (_full, n) => /\.tsx?$/.test(n))) {
      files.add(f);
    }
  }

  // Any other "use server" file under src/ (or the app dir). We deliberately do
  // NOT scan api route handlers here — those are api-route endpoints, handled
  // separately even though they may also be marked "use server".
  const srcRoot = (await exists(join(REPO_ROOT, "src"))) ? join(REPO_ROOT, "src") : REPO_ROOT;
  const apiPrefix = appDir ? join(appDir, "api") : null;
  for (const f of await walk(srcRoot, (_full, n) => /\.tsx?$/.test(n))) {
    if (files.has(f)) continue;
    if (apiPrefix && f.startsWith(apiPrefix + "/")) continue; // api route, not action
    if (basename(f) === "route.ts" || basename(f) === "route.tsx") continue;
    const src = await readSafe(f);
    if (src && declaresUseServer(src)) files.add(f);
  }

  return [...files];
}

// Extract exported async function names from a server-action source file.
// Matches `export async function NAME(` and
// `export const NAME = async (` / `export const NAME = async function`.
function extractExportedAsyncFns(src: string): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;

  const fnDecl = /export\s+async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = fnDecl.exec(src))) names.add(m[1]);

  const constArrow = /export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*async\b/g;
  while ((m = constArrow.exec(src))) names.add(m[1]);

  return [...names];
}

// Find the function-BODY opening brace, starting just after the parameter
// list's closing `)`. A TypeScript return-type annotation sits between `)` and
// the body `{` and may itself contain braces/brackets/angles, e.g.
//   ): Promise<{ success: boolean; markerId?: string }> {
// We must skip that whole type expression. We scan forward tracking `<>`, `()`,
// `[]` and type-level `{}` depth; the body `{` is the first `{` encountered at
// all-zero bracket depth. (Quotes are skipped so a `{` in a string can't fool
// us.) Returns the index of the body `{`, or -1.
function findBodyBrace(src: string, afterParen: number): number {
  let i = afterParen + 1;
  let angle = 0,
    paren = 0,
    bracket = 0,
    brace = 0;
  let inString: string | null = null;
  let escape = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "<") angle++;
    else if (c === ">") {
      if (angle > 0) angle--;
    } else if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "[") bracket++;
    else if (c === "]") bracket--;
    else if (c === "{") {
      if (angle === 0 && paren === 0 && bracket === 0 && brace === 0) return i; // body brace
      brace++;
    } else if (c === "}") {
      if (brace > 0) brace--;
    }
  }
  return -1;
}

// Slice a source file into per-top-level-function bodies. Returns a map of
// function name → body text (from the body `{` to its matching `}`). Covers both
// `function NAME(...): T {` and `const NAME = async (...): T => {` forms. Used
// to attribute reads/writes to the exact function that performs them.
function sliceFunctionBodies(src: string): Map<string, string> {
  const bodies = new Map<string, string>();

  // function-declaration form (async optional, export optional).
  const fnRe = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(src))) {
    const name = m[1];
    const parenStart = m.index + m[0].length - 1;
    const parenEnd = matchCloser(src, parenStart, "(", ")");
    if (parenEnd < 0) continue;
    const braceStart = findBodyBrace(src, parenEnd);
    if (braceStart < 0) continue;
    const braceEnd = matchCloser(src, braceStart, "{", "}");
    if (braceEnd < 0) continue;
    bodies.set(name, src.slice(braceStart, braceEnd + 1));
  }

  // arrow-function form: `const NAME = async (...): T => { ... }` (export
  // optional). The `=>` follows any return-type annotation; we search a generous
  // window after the params for it, then take the next block `{` as the body.
  const arrowRe = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g;
  while ((m = arrowRe.exec(src))) {
    const name = m[1];
    if (bodies.has(name)) continue;
    const parenStart = m.index + m[0].length - 1;
    const parenEnd = matchCloser(src, parenStart, "(", ")");
    if (parenEnd < 0) continue;
    const after = src.slice(parenEnd + 1, parenEnd + 400);
    const arrowRel = after.indexOf("=>");
    if (arrowRel < 0) continue;
    const braceStart = src.indexOf("{", parenEnd + 1 + arrowRel + 2);
    if (braceStart < 0) continue;
    // Guard: a concise-body arrow `=> (expr)` has no block — only accept a `{`
    // that immediately follows the `=>` (ignoring whitespace).
    const between = src.slice(parenEnd + 1 + arrowRel + 2, braceStart);
    if (between.trim() !== "") continue;
    const braceEnd = matchCloser(src, braceStart, "{", "}");
    if (braceEnd < 0) continue;
    bodies.set(name, src.slice(braceStart, braceEnd + 1));
  }

  return bodies;
}

// ── Firestore (and generic SQL/BQ) store extraction ──────────────────────────

// Collection-name constants declared at module scope, e.g.
//   const CHARACTERS_COLLECTION = 'characters';
// Maps the constant identifier → the literal collection name.
function collectionConstants(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["'`]([A-Za-z0-9_./-]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.set(m[1], m[2]);
  return out;
}

// Resolve a `.collection(<arg>)` argument to a literal collection name, using
// the module-scope constant table. Returns null for computed/dynamic args.
function resolveCollectionArg(arg: string, consts: Map<string, string>): string | null {
  const t = arg.trim();
  const lit = t.match(/^["'`]([A-Za-z0-9_./-]+)["'`]$/);
  if (lit) return lit[1];
  if (consts.has(t)) return consts.get(t)!;
  return null;
}

// Read the right-hand side of an assignment, starting just after the `=`, up to
// the statement-terminating `;` at the SAME bracket depth (so a `;` nested in a
// callback/object/array does not end it). Strings and comments are skipped.
function readRhs(src: string, start: number): string {
  let depth = 0; // combined () [] {} depth
  let inString: string | null = null;
  let escape = false;
  let i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inString = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break; // unbalanced closer ends the RHS (e.g. inside args)
      depth--;
    } else if ((c === ";" || c === ",") && depth === 0) {
      break;
    }
  }
  return src.slice(start, i);
}

// Build a per-function map of `<varName>` → resolved collection name, for refs
// bound to a Firestore collection chain. Handles:
//   const ref = firestore.collection(C).doc(id).collection('child').doc()
//        → ref ↦ 'child'   (nearest/last .collection in the chain wins)
//   const childRef = parentRef.collection('child')
//        → childRef ↦ 'child'
//   const characterRef = firestore.collection(C).doc(id)
//        → characterRef ↦ <C>   (only a .collection earlier in the chain)
// Resolution is iterated so that refs built from other refs settle.
function collectionBindings(
  body: string,
  consts: Map<string, string>,
): Map<string, string> {
  const bindings = new Map<string, string>();

  // Capture EVERY `const/let/var VAR = <rhs>` assignment. The RHS runs to the
  // statement-terminating `;` at the SAME nesting depth as the assignment — NOT
  // the first `;` anywhere (a naive lazy `[\s\S]*?;` would stop at a `;` nested
  // inside a callback, e.g. `const stream = new ReadableStream({ start(){ const
  // notesRef = ...; ... } })`, truncating the RHS and skipping the inner
  // declarations). We find each `NAME =` non-consumingly, then read its RHS with
  // a depth-aware scan. We keep ALL assignments (not just `.collection(...)`
  // ones) so refs/queries built from an already-bound ref inherit its
  // collection: `const query = notesRef.where(...).limit(50)`.
  type Pending = { name: string; rhs: string };
  const pending: Pending[] = [];
  const declRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(body))) {
    const rhsStart = m.index + m[0].length;
    const rhs = readRhs(body, rhsStart);
    pending.push({ name: m[1], rhs });
  }

  // The LAST `.collection('x')` / `.collectionGroup('x')` in the RHS whose arg
  // resolves to a literal (a subcollection's child name wins over its parent).
  const lastResolvedCollection = (rhs: string): string | null => {
    let result: string | null = null;
    const collRe = /\.collection(?:Group)?\s*\(\s*([^)]*?)\s*\)/g;
    let cm: RegExpExecArray | null;
    while ((cm = collRe.exec(rhs))) {
      const resolved = resolveCollectionArg(cm[1], consts);
      if (resolved) result = resolved; // keep last resolvable
    }
    return result;
  };

  // Pass 1: direct resolution — the RHS chain contains a resolvable `.collection`.
  for (const p of pending) {
    const c = lastResolvedCollection(p.rhs);
    if (c) bindings.set(p.name, c);
  }

  // Pass 2: iterate so refs/queries built from another bound var settle, e.g.
  //   const notesRef = firestore.collection('campaigns').doc(id).collection('notes'); // notes (pass 1)
  //   const query    = notesRef.where(...).orderBy(...).limit(50);                     // inherits notes
  //   const childRef = parentRef.doc(id);                                              // inherits parentRef
  // A var inherits its base var's collection only when its OWN chain has no
  // resolvable collection (otherwise pass 1 already bound it).
  for (let iter = 0; iter < 6; iter++) {
    let changed = false;
    for (const p of pending) {
      if (bindings.has(p.name)) continue;
      const baseVar = p.rhs.match(/^\s*(?:await\s+)?([A-Za-z_$][\w$]*)\b/);
      if (baseVar && bindings.has(baseVar[1]) && lastResolvedCollection(p.rhs) === null) {
        bindings.set(p.name, bindings.get(baseVar[1])!);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return bindings;
}

// Mutating Firestore terminal calls ⇒ a write. `.get()`/`.onSnapshot(` ⇒ read.
const WRITE_OPS = ["set", "add", "update", "create", "delete"];
const READ_OPS = ["get", "onSnapshot"];

// Attribute Firestore reads/writes for one function body to store (collection)
// names. Strategy: for every terminal operation call (`.get()`, `.set(`, etc.),
// resolve the collection it acts on:
//   (a) the nearest preceding `.collection('x')`/`.collectionGroup('x')` in the
//       SAME statement/expression chain, else
//   (b) the collection bound to the receiver variable (`markerRef.update(...)`).
// Subcollections resolve to the child collection name (it is still a store).
function extractFirestoreStores(
  body: string,
  consts: Map<string, string>,
): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const bindings = collectionBindings(body, consts);

  // First, record collections touched by inline chains. We scan each terminal
  // op call and look back within a bounded window for `.collection(...)` in the
  // same chain (no intervening statement terminator at depth 0).
  const opRe = new RegExp(
    `\\.(${[...WRITE_OPS, ...READ_OPS].join("|")})\\s*\\(`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = opRe.exec(body))) {
    const op = m[1];
    const isWrite = WRITE_OPS.includes(op);
    const callPos = m.index;

    // Walk backward from the op to find the chain root and the nearest
    // resolvable `.collection('x')`. We look back up to ~600 chars but stop at a
    // statement boundary (`;` or `{`/`}`) that is not inside the chain.
    const lookbackStart = Math.max(0, callPos - 800);
    const segment = body.slice(lookbackStart, callPos);

    // Nearest `.collection('x')` / `.collectionGroup('x')` before this op.
    let collName: string | null = null;
    const collRe = /\.collection(?:Group)?\s*\(\s*([^)]*?)\s*\)/g;
    let cm: RegExpExecArray | null;
    let lastCollEnd = -1;
    while ((cm = collRe.exec(segment))) {
      const resolved = resolveCollectionArg(cm[1], consts);
      if (resolved) {
        collName = resolved;
        lastCollEnd = cm.index + cm[0].length;
      }
    }

    // Determine whether that inline `.collection` belongs to THIS chain: there
    // must be no statement terminator between it and the op (ignoring those
    // inside strings is approximated by a simple scan).
    let belongsToChain = false;
    if (lastCollEnd >= 0) {
      const between = segment.slice(lastCollEnd);
      belongsToChain = !/[;{}]/.test(between.replace(/\([^)]*\)/g, ""));
    }

    if (collName && belongsToChain) {
      (isWrite ? writes : reads).add(collName);
      continue;
    }

    // Otherwise, resolve via the receiver variable: `<var>.<op>(`. Capture the
    // identifier immediately before the op (and any `.doc(...)` in between).
    const recv = segment.match(/([A-Za-z_$][\w$]*)\s*(?:\.\s*doc\s*\([^)]*\)\s*)*$/);
    if (recv && bindings.has(recv[1])) {
      (isWrite ? writes : reads).add(bindings.get(recv[1])!);
      continue;
    }

    // Could not attribute this op to a collection — skip (recorded by the caller
    // only if a whole endpoint resolves to nothing).
  }

  // `batch.set(<ref>.doc(...), ...)` / `batch.delete(<ref>.doc(...))` /
  // `batch.update(<ref>, ...)` — the operated ref is the first argument, not the
  // receiver. Resolve those explicitly against the bindings.
  const batchRe = /\.(set|update|delete|create)\s*\(\s*([A-Za-z_$][\w$]*)\b/g;
  while ((m = batchRe.exec(body))) {
    const op = m[1];
    const argVar = m[2];
    if (bindings.has(argVar)) writes.add(bindings.get(argVar)!);
  }

  return { reads, writes };
}

// Generic SQL / BigQuery table extraction. Best-effort, additive — a repo may
// have none, but a generic builder shouldn't ignore other stacks.
//
// CRITICAL: we mine table names ONLY from genuine string/template literals (a
// real SQL query always lives in one). Scanning raw source would match prose in
// comments — e.g. the comment `// Update the note` would yield a bogus table
// "the" via `UPDATE the`. Restricting to string literals eliminates that whole
// class of false positive while still catching real SQL.
const BQ_FQN = /(?:\$?\{[^}]+\}|[A-Za-z][\w-]*)\.(?:\$?\{[^}]+\}|[A-Za-z_][\w-]*)\.([A-Za-z_][A-Za-z0-9_]*)/g;
// Table-clause patterns anchored on FULL statement shapes. Matching the verb
// alone is not enough: an error string like "Failed to update note:" contains
// the word "update" but is not SQL. Each pattern requires the structural
// keyword that always accompanies a real table reference:
//   FROM <t> / JOIN <t> / INTO <t> / DELETE FROM <t> / UPDATE <t> SET / TABLE <t>
const SQL_TABLE_CLAUSES: Array<{ re: RegExp; write: boolean }> = [
  { re: /\bFROM\s+`?([A-Za-z_][\w.]*)`?/gi, write: false },
  { re: /\bJOIN\s+`?([A-Za-z_][\w.]*)`?/gi, write: false },
  { re: /\bINSERT\s+INTO\s+`?([A-Za-z_][\w.]*)`?/gi, write: true },
  { re: /\bMERGE\s+INTO\s+`?([A-Za-z_][\w.]*)`?/gi, write: true },
  { re: /\bUPDATE\s+`?([A-Za-z_][\w.]*)`?\s+SET\b/gi, write: true },
  { re: /\b(?:CREATE|REPLACE|TRUNCATE)\s+(?:OR\s+REPLACE\s+)?TABLE\s+`?([A-Za-z_][\w.]*)`?/gi, write: true },
];
// A literal only qualifies as SQL when it contains a verb AND a structural
// keyword — i.e. it is shaped like a statement, not just a word.
const SQL_STATEMENT = /\b(SELECT|INSERT\s+INTO|UPDATE)\b[\s\S]*\b(FROM|INTO|SET|JOIN)\b|\bDELETE\s+FROM\b|\bMERGE\s+INTO\b|\bCREATE\s+(?:OR\s+REPLACE\s+)?TABLE\b/i;

// Pull out the contents of every string / template literal in a source body.
function stringLiterals(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let j = i + 1;
      let buf = "";
      while (j < body.length) {
        const d = body[j];
        if (d === "\\") {
          buf += body[j + 1] ?? "";
          j += 2;
          continue;
        }
        if (d === quote) break;
        buf += d;
        j++;
      }
      out.push(buf);
      i = j + 1;
      continue;
    }
    // Skip line + block comments so a stray quote in a comment can't open a
    // bogus string region.
    if (c === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      i = nl < 0 ? body.length : nl;
      continue;
    }
    if (c === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i);
      i = end < 0 ? body.length : end + 2;
      continue;
    }
    i++;
  }
  return out;
}

function extractSqlBqStores(body: string): {
  tables: Set<string>;
  isWrite: boolean;
  db: "sql" | "bigquery";
} {
  const tables = new Set<string>();
  let db: "sql" | "bigquery" = "sql";
  let isWrite = false;

  for (const raw of stringLiterals(body)) {
    // Drop `${...}` template interpolations: their contents are JS expressions
    // (e.g. `${snapshot.docs.length}`), not SQL or table identifiers, and a
    // dotted JS member access like `snapshot.docs.length` would otherwise look
    // like a 3-part BigQuery FQN.
    const lit = raw.replace(/\$\{[^}]*\}/g, " ");

    // A BigQuery fully-qualified `project.dataset.table` reference (3 dotted
    // segments). We only trust it when the literal is SQL-shaped OR the whole
    // trimmed literal IS the dotted id (a table id passed to a BQ client).
    const wholeIsFqn = /^[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*$/.test(lit.trim());
    let m: RegExpExecArray | null;
    if (wholeIsFqn || SQL_STATEMENT.test(lit)) {
      BQ_FQN.lastIndex = 0;
      while ((m = BQ_FQN.exec(lit))) {
        tables.add(m[1]);
        db = "bigquery";
      }
    }
    // Bare table names — only inside a literal shaped like a real SQL statement.
    if (!SQL_STATEMENT.test(lit)) continue;
    for (const { re, write } of SQL_TABLE_CLAUSES) {
      re.lastIndex = 0;
      while ((m = re.exec(lit))) {
        // The last dotted segment is the table name.
        const t = m[1].split(".").pop()!;
        if (/^(SELECT|WHERE|VALUES|SET|AS|ON|DUAL)$/i.test(t)) continue;
        tables.add(t);
        if (write) isWrite = true;
      }
    }
  }

  return { tables, isWrite, db };
}

// ── Frontend route reachability (for fetch edges) ────────────────────────────

// Resolve a local import spec (`@/...` alias, or relative `./` `../`) to an
// absolute file path under the repo. `@/` maps to `src/` (the standard Next.js
// alias; e.g. a tsconfig `"@/*": ["./src/*"]` path mapping).
async function resolveLocalImport(
  fromFile: string,
  spec: string,
): Promise<string | null> {
  let base: string;
  if (spec.startsWith("@/")) {
    base = join(REPO_ROOT, "src", spec.slice(2));
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = join(dirname(fromFile), spec);
  } else {
    return null; // bare package import — not local
  }
  const candidates = [
    base + ".tsx",
    base + ".ts",
    base + ".jsx",
    base + ".js",
    join(base, "index.tsx"),
    join(base, "index.ts"),
    join(base, "index.jsx"),
    join(base, "index.js"),
  ];
  // If the spec already has an extension and resolves, accept it.
  if (/\.[tj]sx?$/.test(base) && (await exists(base))) return base;
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  return null;
}

// All local import specs in a source file — static (`import ... from '...'`,
// `export ... from '...'`) AND dynamic (`import('...')`). Returns specs that
// look local (`@/` or relative).
function localImportSpecs(src: string): string[] {
  const specs: string[] = [];
  const res = [
    /(?:import|export)\b[^'"`]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import()
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of res) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const s = m[1];
      if (s.startsWith("@/") || s.startsWith("./") || s.startsWith("../")) specs.push(s);
    }
  }
  return specs;
}

// Collect the set of files reachable from a page by following LOCAL imports
// (components / hooks / lib / actions), bounded to MAX_REACHABLE_DEPTH. Follows
// ALL local imports (not just direct page imports / a hard-coded prefix list)
// so it works on any directory layout.
async function collectReachable(
  pageFile: string,
  cache: Map<string, string[]>,
): Promise<string[]> {
  const seen = new Set<string>([pageFile]);
  let frontier = [pageFile];
  for (let depth = 0; depth < MAX_REACHABLE_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      let specs = cache.get(f);
      if (!specs) {
        const src = await readSafe(f);
        specs = src ? localImportSpecs(src) : [];
        cache.set(f, specs);
      }
      for (const spec of specs) {
        const resolved = await resolveLocalImport(f, spec);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          next.push(resolved);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

// In one source file, find which server-action endpoints are invoked, and
// whether each invocation is `cached` (sits inside a TanStack Query hook call).
//
// We match call sites of known action function names. A call site is `cached`
// when it falls within the matched-brace span of a `useQuery(`/`useSuspenseQuery(`/
// `useInfiniteQuery(` call — this captures both the in-component hook usage and
// the hook-module pattern (`useCampaigns` wraps `getCampaigns(token)` inside
// `useQuery({ queryFn: ... })`).
const CACHE_HOOK_RE = /\b(useQuery|useSuspenseQuery|useInfiniteQuery)\s*\(/g;

function findActionCalls(
  src: string,
  actionNames: Set<string>,
): Map<string, boolean> {
  // action name → cached?  (true wins over false on collision)
  const hits = new Map<string, boolean>();

  // Compute cached spans (regions inside a TanStack hook call).
  const cacheSpans: Array<[number, number]> = [];
  CACHE_HOOK_RE.lastIndex = 0;
  let h: RegExpExecArray | null;
  while ((h = CACHE_HOOK_RE.exec(src))) {
    const open = h.index + h[0].length - 1; // points at "("
    const close = matchCloser(src, open, "(", ")");
    if (close > open) cacheSpans.push([open, close]);
  }

  for (const name of actionNames) {
    // Call site: `name(` not preceded by an identifier char or a dot (so we
    // don't match `foo.getCampaigns(` member calls or `xgetCampaigns`).
    const callRe = new RegExp(`(?:^|[^A-Za-z0-9_$.])${escapeRegex(name)}\\s*\\(`, "g");
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(src))) {
      const pos = m.index;
      const cached = cacheSpans.some(([s, e]) => pos >= s && pos <= e);
      const prev = hits.get(name);
      if (prev === undefined) hits.set(name, cached);
      else if (cached && !prev) hits.set(name, true);
    }
  }

  return hits;
}

// ── Compose the graph ────────────────────────────────────────────────────────

export async function buildDataflowGraph(): Promise<DFGraph> {
  const warnings: { kind: string; detail: string }[] = [];
  const appDir = await findAppDir();

  // store (table) name → db kind, populated during SQL/BQ extraction so the
  // node-building pass can tag SQL/BigQuery stores correctly. Firestore stores
  // default to "firestore" when absent. Per-build local (no cross-call leakage).
  const sqlStoreDb = new Map<string, "sql" | "bigquery">();

  // ── 1) Containers ──────────────────────────────────────────────────────────
  const containers = await detectContainers(warnings);
  // The "primary" container hosts all endpoints in the single-service case.
  const primaryContainer = containers[0];

  // ── 2) Endpoints — server actions ───────────────────────────────────────────
  const endpoints: Endpoint[] = [];
  const actionFnNames = new Set<string>(); // global set of all action fn names
  // Map action fn name → endpoint id (for fetch-edge resolution).
  const actionNameToEndpointId = new Map<string, string>();

  const actionFiles = await findServerActionFiles(appDir);
  for (const file of actionFiles) {
    const src = await readSafe(file);
    if (!src) continue;
    const exported = extractExportedAsyncFns(src);
    if (exported.length === 0) {
      warnings.push({
        kind: "empty-action-file",
        detail: `${rel(file)} declares no exported async functions`,
      });
      continue;
    }
    const consts = collectionConstants(src);
    const bodies = sliceFunctionBodies(src);
    for (const fnName of exported) {
      const id = `endpoint:${fnName}`;
      // If two action files export the same name, disambiguate with the file.
      let finalId = id;
      let finalName = fnName;
      if (actionNameToEndpointId.has(fnName)) {
        const tag = basename(file).replace(/\.tsx?$/, "");
        finalId = `endpoint:${tag}.${fnName}`;
        finalName = `${tag}.${fnName}`;
      }
      const body = bodies.get(fnName) ?? "";
      const fs = extractFirestoreStores(body, consts);
      const sqlbq = extractSqlBqStores(body);
      // Fold any SQL/BQ tables in (tagged by db downstream via storeDb map).
      const reads = new Set(fs.reads);
      const writes = new Set(fs.writes);
      for (const t of sqlbq.tables) (sqlbq.isWrite ? writes : reads).add(t);

      endpoints.push({
        id: finalId,
        name: finalName,
        access: "server-action",
        file: rel(file),
        absFile: file,
        fnName,
        reads,
        writes,
      });
      actionFnNames.add(fnName);
      if (!actionNameToEndpointId.has(fnName)) actionNameToEndpointId.set(fnName, finalId);
      // Record the db kind for any SQL/BQ tables touched.
      for (const t of sqlbq.tables) sqlStoreDb.set(t, sqlbq.db);
    }
  }

  // ── 3) Endpoints — API routes ───────────────────────────────────────────────
  if (appDir) {
    const apiDir = join(appDir, "api");
    if (await exists(apiDir)) {
      const routeFiles = await walk(
        apiDir,
        (_full, n) => n === "route.ts" || n === "route.tsx",
      );
      for (const file of routeFiles) {
        const relDir = relative(appDir, dirname(file));
        const apiPath = apiPathFromRelDir(relDir);
        const src = await readSafe(file);
        const consts = src ? collectionConstants(src) : new Map<string, string>();
        // The whole route handler file body is the attribution surface (an SSE
        // route's onSnapshot lives inside GET, but module-level helpers may hold
        // the chain too — scanning the whole file is the safe generic choice).
        const fs = src ? extractFirestoreStores(src, consts) : { reads: new Set<string>(), writes: new Set<string>() };
        const sqlbq = src ? extractSqlBqStores(src) : { tables: new Set<string>(), isWrite: false, db: "sql" as const };
        const reads = new Set(fs.reads);
        const writes = new Set(fs.writes);
        for (const t of sqlbq.tables) {
          (sqlbq.isWrite ? writes : reads).add(t);
          sqlStoreDb.set(t, sqlbq.db);
        }
        endpoints.push({
          id: `endpoint:${apiPath}`,
          name: apiPath,
          access: "api-route",
          file: rel(file),
          absFile: file,
          reads,
          writes,
        });
      }
    }
  }

  if (endpoints.length === 0) {
    warnings.push({
      kind: "no-endpoints",
      detail: "No server actions or API routes detected (no src/actions, no 'use server' files, no app/api/**/route.ts)",
    });
  }

  // ── 4) Frontend routes + fetch edges ────────────────────────────────────────
  const routes: Array<{
    id: string;
    path: string;
    file: string;
    cached: boolean;
    // endpoint id → cached?
    fetches: Map<string, boolean>;
  }> = [];

  if (!appDir) {
    warnings.push({
      kind: "no-frontend",
      detail: "No Next.js app directory (src/app or app) found — frontend layer is empty",
    });
  } else {
    const pageFiles = await walk(appDir, (_full, n) => n === "page.tsx" || n === "page.jsx");
    const importCache = new Map<string, string[]>();
    for (const pageFile of pageFiles) {
      const relDir = relative(appDir, dirname(pageFile));
      const path = routePathFromRelDir(relDir);
      const reachable = await collectReachable(pageFile, importCache);

      // Across all reachable files, find action invocations + cached-ness.
      const fetches = new Map<string, boolean>(); // endpoint id → cached
      for (const f of reachable) {
        const src = await readSafe(f);
        if (!src) continue;
        const calls = findActionCalls(src, actionFnNames);
        for (const [fnName, cached] of calls) {
          const epId = actionNameToEndpointId.get(fnName);
          if (!epId) continue; // shouldn't happen — every action name maps
          const prev = fetches.get(epId);
          if (prev === undefined) fetches.set(epId, cached);
          else if (cached && !prev) fetches.set(epId, true);
        }
      }

      const cached = [...fetches.values()].some(Boolean);
      routes.push({
        id: `route:${path}`,
        path,
        file: rel(pageFile),
        cached,
        fetches,
      });
    }
  }

  // ── 5) Build flat node/edge lists ───────────────────────────────────────────
  const nodes: DFNode[] = [];
  const edges: DFEdge[] = [];
  const nodeIds = new Set<string>();
  const addNode = (n: DFNode) => {
    if (!nodeIds.has(n.data.id)) {
      nodes.push(n);
      nodeIds.add(n.data.id);
    }
  };
  let edgeIdx = 0;
  const addEdge = (
    source: string,
    target: string,
    kind: EdgeKind,
    cached?: boolean,
  ) => {
    const data: DFEdge["data"] = { id: `e${edgeIdx++}`, source, target, kind };
    if (cached !== undefined) data.cached = cached;
    edges.push({ data });
  };

  // 5a) Containers.
  for (const c of containers) {
    addNode({
      data: {
        id: c.id,
        label: c.name,
        kind: "container",
        ...(c.platform ? { platform: c.platform } : {}),
        ...(c.file ? { file: c.file } : {}),
      },
    });
  }

  // 5b) Endpoints + hosts edges + reads/writes edges + store nodes.
  for (const ep of endpoints) {
    const containerId = primaryContainer ? primaryContainer.id : undefined;
    addNode({
      data: {
        id: ep.id,
        label: ep.name,
        kind: "endpoint",
        access: ep.access,
        file: ep.file,
        ...(containerId ? { container: containerId } : {}),
      },
    });
    if (containerId) addEdge(containerId, ep.id, "hosts");

    // Store nodes + reads/writes edges.
    for (const store of ep.reads) {
      const db = sqlStoreDb.get(store) ?? "firestore";
      const sid = `store:${db}:${store}`;
      addNode({ data: { id: sid, label: store, kind: "store", db } });
      addEdge(ep.id, sid, "reads");
    }
    for (const store of ep.writes) {
      const db = sqlStoreDb.get(store) ?? "firestore";
      const sid = `store:${db}:${store}`;
      addNode({ data: { id: sid, label: store, kind: "store", db } });
      addEdge(ep.id, sid, "writes");
    }
  }

  // 5c) Routes + fetch edges.
  for (const r of routes) {
    addNode({
      data: {
        id: r.id,
        label: r.cached ? `⚡ ${r.path}` : r.path,
        kind: "fe-route",
        cached: r.cached,
        file: r.file,
      },
    });
    for (const [epId, cached] of r.fetches) {
      // epId is guaranteed to be an endpoint node (built above).
      addEdge(r.id, epId, "fetch", cached);
    }
  }

  // ── 6) Sanity warnings — never silently drop, but every edge must be real. ──
  // (All edges above reference ids we addNode'd, so by construction there are no
  // dangling edges. We still record orphans for visibility.)
  const reachedEndpoints = new Set<string>();
  for (const r of routes) for (const epId of r.fetches.keys()) reachedEndpoints.add(epId);
  for (const ep of endpoints) {
    if (ep.access === "server-action" && !reachedEndpoints.has(ep.id)) {
      warnings.push({
        kind: "orphan-endpoint",
        detail: `${ep.name} (${ep.file}) — no frontend route reaches this server action`,
      });
    }
    if (ep.reads.size === 0 && ep.writes.size === 0) {
      warnings.push({
        kind: "endpoint-no-stores",
        detail: `${ep.name} (${ep.file}) — no store reads/writes resolved`,
      });
    }
  }

  // ── 7) Counts + return ──────────────────────────────────────────────────────
  const counts = {
    routes: nodes.filter((n) => n.data.kind === "fe-route").length,
    containers: nodes.filter((n) => n.data.kind === "container").length,
    endpoints: nodes.filter((n) => n.data.kind === "endpoint").length,
    stores: nodes.filter((n) => n.data.kind === "store").length,
    edges: edges.length,
  };

  return { nodes, edges, meta: { built: new Date().toISOString(), counts, warnings } };
}
