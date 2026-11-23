#!/usr/bin/env node
// Standardized upstream sync helper for T3 Lab (Extend) (`davidlokus/t3code-lmx`).
// Default mode is read-only: fetches upstream/origin, validates ancestry, detects added upstream
// workflows, runs an in-memory `git merge-tree` conflict forecast, and prints exact commands.
// Pass `--prepare` to create an isolated `sync/upstream-*` worktree and run `git merge --no-ff`.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const FORK_REPO = "davidlokus/t3code-lmx";
const UPSTREAM_REPO = "pingdotgg/t3code";
const DEFAULT_BRANCH = "lmx-lab";
const MIRROR_BRANCH = "main";

function run(cmd, args, { cwd, allowFail = false } = {}) {
  try {
    return NodeChildProcess.execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFail) return null;
    const stderr = error?.stderr?.toString?.().trim();
    const stdout = error?.stdout?.toString?.().trim();
    throw new Error(
      `Command failed: ${cmd} ${args.join(" ")}\n${stderr || stdout || error.message}`,
      { cause: error },
    );
  }
}

function fail(message, code = 1) {
  console.error(`FAIL: ${message}`);
  NodeProcess.exit(code);
}

function printUsage() {
  console.error(
    "Usage: node fork/scripts/sync-upstream.mjs [target-ref] [options]\n" +
      "\n" +
      "Arguments:\n" +
      "  target-ref           Upstream ref, tag, or SHA (default: upstream/main)\n" +
      "\n" +
      "Options:\n" +
      "  --prepare            Create adjacent sync worktree and run `git merge --no-ff`\n" +
      "  --fast-forward-main  Fast-forward `origin/main` mirror to target-ref (with --prepare)\n" +
      "  --worktree <path>    Override adjacent worktree directory (with --prepare)\n" +
      "  --no-fetch           Skip `git fetch` and inspect current local refs only\n" +
      "  -h, --help           Show this help\n",
  );
}

const rawArgs = NodeProcess.argv.slice(2);
if (rawArgs.includes("-h") || rawArgs.includes("--help")) {
  printUsage();
  NodeProcess.exit(0);
}

const prepare = rawArgs.includes("--prepare");
const fastForwardMain = rawArgs.includes("--fast-forward-main");
const noFetch = rawArgs.includes("--no-fetch");
let explicitWorktree;
const positional = [];

for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === "--prepare" || arg === "--fast-forward-main" || arg === "--no-fetch") continue;
  if (arg === "--worktree") {
    const next = rawArgs[i + 1];
    if (!next || next.startsWith("-")) fail("--worktree requires a directory path.", 2);
    explicitWorktree = next;
    i += 1;
    continue;
  }
  if (arg.startsWith("-")) fail(`Unknown option: ${arg}`, 2);
  positional.push(arg);
}

if (positional.length > 1) {
  printUsage();
  NodeProcess.exit(2);
}

if (fastForwardMain && !prepare) {
  fail("--fast-forward-main can only be combined with --prepare.", 2);
}

const targetInput = positional[0] ?? `upstream/${MIRROR_BRANCH}`;
const repoRoot = run("git", ["rev-parse", "--show-toplevel"]);

const originUrl = run("git", ["remote", "get-url", "origin"], { cwd: repoRoot });
if (!originUrl.includes(FORK_REPO)) {
  fail(`Expected 'origin' remote to point to ${FORK_REPO}, got: ${originUrl}`);
}

const upstreamUrl = run("git", ["remote", "get-url", "upstream"], {
  cwd: repoRoot,
  allowFail: true,
});
if (!upstreamUrl || !upstreamUrl.includes(UPSTREAM_REPO)) {
  fail(`Expected 'upstream' remote to point to ${UPSTREAM_REPO}, got: ${upstreamUrl ?? "(none)"}`);
}

const upstreamPushUrl = run("git", ["remote", "get-url", "--push", "upstream"], {
  cwd: repoRoot,
  allowFail: true,
});
if (upstreamPushUrl !== "DISABLE") {
  fail(
    `Expected 'upstream' push URL to be DISABLE, got: ${upstreamPushUrl ?? "(unset)"}. Fix with: git remote set-url --push upstream DISABLE`,
  );
}

if (!noFetch) {
  console.log("Fetching upstream (main + tags) and origin (main + lmx-lab)...");
  run("git", ["fetch", "upstream", MIRROR_BRANCH, "--tags"], { cwd: repoRoot });
  run("git", ["fetch", "origin", MIRROR_BRANCH, DEFAULT_BRANCH, "--prune"], { cwd: repoRoot });
}

const upstreamMainSha = run("git", ["rev-parse", `upstream/${MIRROR_BRANCH}^{commit}`], {
  cwd: repoRoot,
});
const originMainSha = run("git", ["rev-parse", `origin/${MIRROR_BRANCH}^{commit}`], {
  cwd: repoRoot,
});
const lmxLabSha = run("git", ["rev-parse", `origin/${DEFAULT_BRANCH}^{commit}`], {
  cwd: repoRoot,
});
const targetSha = run("git", ["rev-parse", `${targetInput}^{commit}`], {
  cwd: repoRoot,
  allowFail: true,
});
if (!targetSha) {
  fail(`Could not resolve upstream target "${targetInput}". Verify the tag, ref, or SHA exists.`);
}

const targetInUpstreamMain = run(
  "git",
  ["merge-base", "--is-ancestor", targetSha, upstreamMainSha],
  { cwd: repoRoot, allowFail: true },
);
if (targetInUpstreamMain === null) {
  fail(
    `Target ${targetInput} (${targetSha.slice(0, 10)}) is not an ancestor of upstream/${MIRROR_BRANCH} (${upstreamMainSha.slice(0, 10)}).`,
  );
}

const mirrorCanFastForward = run("git", ["merge-base", "--is-ancestor", originMainSha, targetSha], {
  cwd: repoRoot,
  allowFail: true,
});
if (mirrorCanFastForward === null) {
  fail(
    `origin/${MIRROR_BRANCH} (${originMainSha.slice(0, 10)}) is not an ancestor of target ${targetSha.slice(0, 10)}. Refusing non-fast-forward sync.`,
  );
}

const alreadyMerged = run("git", ["merge-base", "--is-ancestor", targetSha, lmxLabSha], {
  cwd: repoRoot,
  allowFail: true,
});

const shortTarget = targetSha.slice(0, 10);
const aheadMirrorCount = Number(
  run("git", ["rev-list", "--count", `${originMainSha}..${targetSha}`], { cwd: repoRoot }),
);
const aheadLabCount = Number(
  run("git", ["rev-list", "--count", `${lmxLabSha}..${targetSha}`], { cwd: repoRoot }),
);

console.log("");
console.log(`Target:       ${targetInput} (${shortTarget})`);
console.log(
  `origin/main:  ${originMainSha.slice(0, 10)} (${aheadMirrorCount} commits behind target)`,
);
console.log(
  `origin/lmx-lab: ${lmxLabSha.slice(0, 10)} (${aheadLabCount} upstream commits to merge)`,
);

if (alreadyMerged !== null) {
  console.log("");
  console.log(`PASS  origin/${DEFAULT_BRANCH} already contains ${targetInput} (${shortTarget}).`);
  NodeProcess.exit(0);
}

const addedWorkflowsRaw = run(
  "git",
  [
    "diff",
    "--diff-filter=A",
    "--name-only",
    `${originMainSha}..${targetSha}`,
    "--",
    ".github/workflows/",
  ],
  { cwd: repoRoot },
);
const addedWorkflows = addedWorkflowsRaw ? addedWorkflowsRaw.split("\n").filter(Boolean) : [];

const changedUpstreamFiles = new Set(
  run("git", ["diff", "--name-only", `${originMainSha}..${targetSha}`], { cwd: repoRoot })
    .split("\n")
    .filter(Boolean),
);
const changedForkFiles = run("git", ["diff", "--name-only", `${originMainSha}..${lmxLabSha}`], {
  cwd: repoRoot,
})
  .split("\n")
  .filter(Boolean);
const overlappingFiles = changedForkFiles.filter((file) => changedUpstreamFiles.has(file)).sort();

console.log("");
if (addedWorkflows.length > 0) {
  console.log(`WARN  New upstream workflow files detected (${addedWorkflows.length}):`);
  for (const wf of addedWorkflows) console.log(`  - ${wf}`);
  console.log("  Disable these in GitHub Actions after merging so upstream jobs do not run.");
} else {
  console.log("PASS  No new upstream workflow files added in this range.");
}

console.log(`INFO  Overlapping files with fork diff: ${overlappingFiles.length}`);
for (const file of overlappingFiles) console.log(`  - ${file}`);

// In-memory merge forecast (touches no working tree or index).
let mergeTreeConflicts = [];
try {
  NodeChildProcess.execFileSync(
    "git",
    ["merge-tree", "--write-tree", "--name-only", lmxLabSha, targetSha],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  console.log("PASS  Dry-run git merge-tree: 0 conflicts predicted.");
} catch (error) {
  const stdout = error?.stdout?.toString?.() ?? "";
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // First line is the tree OID; following non-CONFLICT paths list conflicting files.
  mergeTreeConflicts = lines
    .slice(1)
    .filter((line) => !line.startsWith("CONFLICT ") && !line.startsWith("Auto-merging "));
  console.log(`WARN  Dry-run git merge-tree predicted conflicts (${mergeTreeConflicts.length}):`);
  for (const file of mergeTreeConflicts) console.log(`  - ${file}`);
}

const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const branchName = `sync/upstream-${today}-${shortTarget}`;
const worktreePath = explicitWorktree
  ? NodePath.resolve(explicitWorktree)
  : NodePath.resolve(repoRoot, "..", `t3code-lmx-sync-${shortTarget}`);

if (!prepare) {
  console.log("");
  console.log("Next step (prepare mirror + isolated sync worktree):");
  console.log(`  node fork/scripts/sync-upstream.mjs ${targetInput} --prepare --fast-forward-main`);
  NodeProcess.exit(0);
}

if (fastForwardMain && originMainSha !== targetSha) {
  console.log("");
  console.log(`Fast-forwarding origin/${MIRROR_BRANCH} to ${shortTarget}...`);
  run("git", ["push", "origin", `${targetSha}:refs/heads/${MIRROR_BRANCH}`], { cwd: repoRoot });
  run("git", ["fetch", "origin", MIRROR_BRANCH], { cwd: repoRoot });
  console.log(`PASS  origin/${MIRROR_BRANCH} fast-forwarded to ${shortTarget}.`);
}

const existingBranch = run("git", ["branch", "--list", branchName], { cwd: repoRoot });
if (existingBranch) {
  fail(`Local branch '${branchName}' already exists. Delete or reuse it explicitly.`);
}
if (NodeFS.existsSync(worktreePath)) {
  fail(`Worktree path already exists: ${worktreePath}`);
}

console.log("");
console.log(`Creating isolated sync worktree at ${worktreePath} (${branchName})...`);
run("git", ["worktree", "add", worktreePath, "-b", branchName, `origin/${DEFAULT_BRANCH}`], {
  cwd: repoRoot,
});

const mergeMessage = `chore(fork): sync upstream ${targetInput} (${shortTarget})`;
let mergeSucceeded = true;
try {
  NodeChildProcess.execFileSync("git", ["merge", "--no-ff", "--no-commit", targetSha], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch {
  mergeSucceeded = false;
}

if (!mergeSucceeded) {
  const unmerged = run("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd: worktreePath,
    allowFail: true,
  });
  console.error("");
  console.error(`WARN  Merge paused with conflicts in ${worktreePath}:`);
  for (const file of (unmerged ?? "").split("\n").filter(Boolean)) {
    console.error(`  - ${file}`);
  }
  console.error("");
  console.error("Resolve conflicts inside that worktree, then run:");
  console.error("  vp i");
  console.error("  vp test run packages/shared/src/forkIdentity.guard.test.ts");
  console.error("  vp run check:changed origin/lmx-lab");
  console.error("  vp run i18n:check");
  console.error(`  git commit -m "${mergeMessage}"`);
  NodeProcess.exit(3);
}

console.log(`PASS  Clean merge staged in ${worktreePath} (not committed yet).`);
console.log("");
console.log("Complete the sync inside the worktree:");
console.log(`  cd ${worktreePath}`);
console.log("  vp i");
console.log("  # Update FORK.md upstream baseline table with date & SHA");
console.log("  vp test run packages/shared/src/forkIdentity.guard.test.ts");
console.log("  vp run check:changed origin/lmx-lab");
console.log("  vp run i18n:check");
console.log(`  git commit -m "${mergeMessage}"`);
console.log(`  git push -u origin ${branchName}`);
console.log(
  `  gh pr create --repo ${FORK_REPO} --base ${DEFAULT_BRANCH} --head ${branchName} --title "${mergeMessage}"`,
);
console.log("  # IMPORTANT: Merge upstream sync PRs with --merge (NEVER --squash):");
console.log(
  `  gh pr merge <pr-number> --repo ${FORK_REPO} --merge --match-head-commit <head-sha> --delete-branch`,
);
