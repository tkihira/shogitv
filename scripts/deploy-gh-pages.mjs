#!/usr/bin/env node
// Build with GH_PAGES=1 and publish dist/ to the gh-pages branch via a temporary git worktree.
//
// Refuses to run if the working tree has uncommitted changes — we want what's deployed to
// match what's on main. Idempotent: safe to re-run.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distDir = join(root, "dist");
const branch = "gh-pages";
const remote = "origin";

function log(msg) {
  console.log(`\x1b[34m[deploy]\x1b[0m ${msg}`);
}
function fail(msg) {
  console.error(`\x1b[31m[deploy] ERROR:\x1b[0m ${msg}`);
  process.exit(1);
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} (exit ${r.status})`);
  return r;
}
function captureGit(args, opts = {}) {
  const r = spawnSync("git", args, { encoding: "utf8", cwd: root, ...opts });
  if (r.status !== 0) fail(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// 1. Refuse to deploy with a dirty tree.
const dirty = captureGit(["status", "--porcelain"]);
if (dirty) {
  fail(
    "Uncommitted changes detected. Commit or stash before deploying so what ships matches main.\n" +
      dirty,
  );
}

// 2. Find current commit (used for the gh-pages commit message).
const headCommit = captureGit(["rev-parse", "--short", "HEAD"]);
const headBranch = captureGit(["rev-parse", "--abbrev-ref", "HEAD"]);
log(`deploying from ${headBranch} @ ${headCommit}`);

// 3. Build for GH Pages.
log("building (GH_PAGES=1 npm run build)…");
run("npm", ["run", "build"], { env: { ...process.env, GH_PAGES: "1" } });
if (!existsSync(distDir)) fail(`expected ${distDir} after build`);

// 4. Make sure we have an up-to-date view of remote refs.
log("fetching remote…");
run("git", ["fetch", remote, "--quiet"]);
const remoteHasBranch = spawnSync("git", [
  "ls-remote",
  "--exit-code",
  "--heads",
  remote,
  branch,
]).status === 0;

// 5. Set up a temporary worktree at gh-pages.
const worktree = mkdtempSync(join(tmpdir(), "shogitv-ghp-"));
log(`worktree: ${worktree}`);
const cleanup = () => {
  // remove worktree even on failure so a stale registration doesn't block reruns
  try {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: root });
  } catch {
    // ignore
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

if (remoteHasBranch) {
  // Check out the existing branch, fast-forwarding if local is behind.
  run("git", [
    "worktree",
    "add",
    "-B",
    branch,
    worktree,
    `${remote}/${branch}`,
  ]);
} else {
  run("git", ["worktree", "add", "--orphan", "-b", branch, worktree]);
}

// 6. Replace the worktree contents with the freshly-built dist.
log("syncing dist → worktree…");
for (const entry of readdirSync(worktree)) {
  if (entry === ".git") continue;
  rmSync(join(worktree, entry), { recursive: true, force: true });
}
cpSync(distDir, worktree, { recursive: true });

// GH Pages flags / housekeeping.
writeFileSync(join(worktree, ".nojekyll"), "");
const headersFile = join(worktree, "_headers");
if (existsSync(headersFile)) rmSync(headersFile);

// 7. Commit and push.
const ghStatus = spawnSync("git", ["status", "--porcelain"], {
  cwd: worktree,
  encoding: "utf8",
});
if (!ghStatus.stdout.trim()) {
  log("no changes vs current gh-pages — skipping commit/push");
  process.exit(0);
}

run("git", ["add", "-A"], { cwd: worktree });
const message = `deploy: gh-pages from ${headCommit}\n\nBuilt with GH_PAGES=1 npm run build, base=/shogitv/.`;
run("git", ["commit", "--quiet", "-m", message], { cwd: worktree });
log(`pushing ${branch} to ${remote}…`);
run("git", ["push", remote, branch], { cwd: worktree });

log("done. site → https://tkihira.github.io/shogitv/");
