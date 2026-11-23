#!/usr/bin/env node
// Read-only pre-release gate for T3 Lab (Extend) (`davidlokus/t3code-lmx`).
// Verifies version format, clean tree, lmx-lab ancestry, tag uniqueness, green Fork CI,
// and fork invariant guard tests before printing the exact tag/push command.

import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";

const REPO = "davidlokus/t3code-lmx";
const DEFAULT_BRANCH = "lmx-lab";
const VERSION_PATTERN = /^\d+\.\d+\.\d+-lab\.\d+$/;

function run(cmd, args, { allowFail = false } = {}) {
  try {
    return NodeChildProcess.execFileSync(cmd, args, {
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

function fail(message) {
  console.error(`FAIL: ${message}`);
  NodeProcess.exit(1);
}

const rawArgs = NodeProcess.argv.slice(2);
const allowBehind = rawArgs.includes("--allow-behind");
const skipCiCheck = rawArgs.includes("--skip-ci-check");
const positional = rawArgs.filter((arg) => !arg.startsWith("--"));

if (positional.length !== 1) {
  console.error(
    "Usage: node fork/scripts/release-preflight.mjs <version> [--allow-behind] [--skip-ci-check]\n" +
      "Example: node fork/scripts/release-preflight.mjs 0.1.11-lab.1",
  );
  NodeProcess.exit(2);
}

const version = positional[0].replace(/^v/, "");
if (!VERSION_PATTERN.test(version)) {
  fail(
    `Invalid fork release version "${positional[0]}". Expected X.Y.Z-lab.N (e.g. 0.1.11-lab.1).`,
  );
}
const tag = `v${version}`;

const status = run("git", ["status", "--porcelain"]);
if (status.length > 0) {
  fail(`Working tree is not clean:\n${status}`);
}

run("git", ["fetch", "origin", DEFAULT_BRANCH, "--tags"]);

const headSha = run("git", ["rev-parse", "HEAD"]);
const branchSha = run("git", ["rev-parse", `origin/${DEFAULT_BRANCH}`]);

const isAncestor = run("git", ["merge-base", "--is-ancestor", headSha, branchSha], {
  allowFail: true,
});
if (isAncestor === null) {
  fail(
    `HEAD (${headSha.slice(0, 10)}) is not an ancestor of origin/${DEFAULT_BRANCH} (${branchSha.slice(0, 10)}).`,
  );
}
if (!allowBehind && headSha !== branchSha) {
  fail(
    `HEAD (${headSha.slice(0, 10)}) is behind origin/${DEFAULT_BRANCH} (${branchSha.slice(0, 10)}). Fast-forward first or pass --allow-behind.`,
  );
}

const localTag = run("git", ["tag", "--list", tag]);
if (localTag === tag) {
  fail(`Tag ${tag} already exists locally.`);
}
const remoteTag = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]);
if (remoteTag.length > 0) {
  fail(`Tag ${tag} already exists on origin.`);
}

if (!skipCiCheck) {
  const rawRuns = run("gh", [
    "run",
    "list",
    "-R",
    REPO,
    "--workflow",
    "Fork CI",
    "--branch",
    DEFAULT_BRANCH,
    "--limit",
    "30",
    "--json",
    "headSha,status,conclusion,url,databaseId",
  ]);
  const runs = JSON.parse(rawRuns);
  const greenRun = runs.find((entry) => {
    if (entry.status !== "completed" || entry.conclusion !== "success") return false;
    if (entry.headSha === headSha) return true;
    return (
      run("git", ["merge-base", "--is-ancestor", headSha, entry.headSha], { allowFail: true }) !==
      null
    );
  });
  if (!greenRun) {
    fail(
      `No completed green "Fork CI" run found on ${DEFAULT_BRANCH} covering ${headSha.slice(0, 10)}. Wait for CI before tagging.`,
    );
  }
  console.log(`PASS  Fork CI green: #${greenRun.databaseId} (${greenRun.url})`);
} else {
  console.log("WARN  Skipped remote Fork CI check (--skip-ci-check)");
}

NodeChildProcess.execFileSync(
  "vp",
  ["test", "run", "packages/shared/src/forkIdentity.guard.test.ts"],
  {
    stdio: "inherit",
  },
);

console.log("");
console.log(`PASS  Preflight succeeded for ${tag} at ${headSha.slice(0, 10)} (${DEFAULT_BRANCH})`);
console.log("");
console.log("Next step (manual or agent-triggered release):");
console.log(`  git tag -a ${tag} ${headSha} -m "T3 Lab (Extend) ${tag}"`);
console.log(`  git push origin ${tag}`);
