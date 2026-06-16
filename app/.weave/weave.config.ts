// Central path + port resolver for the weave dashboard.
//
// Resolution order (highest precedence first):
//   1. WEAVE_* environment variables
//   2. weave.config.json at the repo root (or the path in $WEAVE_CONFIG)
//   3. Relative defaults — the vendored layout, where `.weave/` sits at the
//      repo root beside `.tickets/` and `.claude/`.
//
// A vendored install needs none of this: the defaults resolve correctly because
// `.weave/` is a direct child of the repo root. The overrides exist so the app
// can also run against a ticket store / repo located elsewhere (sidecar, CI,
// tests).

import { join, isAbsolute } from "node:path";
import { readFileSync } from "node:fs";

const HERE = import.meta.dir; // <repo>/.weave
const DEFAULT_REPO_ROOT = join(HERE, ".."); // <repo>

function abs(base: string, p: string): string {
  return isAbsolute(p) ? p : join(base, p);
}

type ConfigFile = {
  repoRoot?: string;
  ticketsRoot?: string;
  adrsRoot?: string;
  port?: number;
};

function loadConfigFile(repoRoot: string): ConfigFile {
  const path = process.env.WEAVE_CONFIG ?? join(repoRoot, "weave.config.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
  } catch {
    return {};
  }
}

const envRepoRoot = process.env.WEAVE_REPO_ROOT;
const probeRoot = envRepoRoot ? abs(process.cwd(), envRepoRoot) : DEFAULT_REPO_ROOT;
const cfg = loadConfigFile(probeRoot);

export const REPO_ROOT: string = envRepoRoot
  ? abs(process.cwd(), envRepoRoot)
  : cfg.repoRoot
    ? abs(DEFAULT_REPO_ROOT, cfg.repoRoot)
    : DEFAULT_REPO_ROOT;

export const TICKETS_ROOT: string = process.env.WEAVE_TICKETS_ROOT
  ? abs(process.cwd(), process.env.WEAVE_TICKETS_ROOT)
  : cfg.ticketsRoot
    ? abs(REPO_ROOT, cfg.ticketsRoot)
    : join(REPO_ROOT, ".tickets");

export const ADRS_ROOT: string = process.env.WEAVE_ADRS_ROOT
  ? abs(process.cwd(), process.env.WEAVE_ADRS_ROOT)
  : cfg.adrsRoot
    ? abs(REPO_ROOT, cfg.adrsRoot)
    : join(TICKETS_ROOT, "ADRs");

export const SKILLS_ROOT: string = join(REPO_ROOT, ".claude", "skills");

export const PORT: number = process.env.PORT
  ? Number(process.env.PORT)
  : typeof cfg.port === "number"
    ? cfg.port
    : 5174;
