#!/usr/bin/env node
// Standardized feature worktree lifecycle helper for T3 Lab (Extend) (`davidlokus/t3code-lmx`).
// Provides `open`, `status`, and `close` for adjacent sibling worktrees (`../<repo>-<topic>`)
// while honoring `.t3/setup-running` live PIDs and protecting `main`/`lmx-lab` and dirty trees.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const FORK_REPO = "davidlokus/t3code-lmx";
const DEFAULT_BRANCH = "lmx-lab";
const DEFAULT_BASE = `origin/${DEFAULT_BRANCH}`;
const DEFAULT_PREFIX = "feat";
const ALLOWED_PREFIXES = new Set(["feat", "fix", "chore", "docs", "refactor", "perf", "test"]);
const PROTECTED_BRANCHES = new Set(["main", "lmx-lab"]);
const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const MAX_RECOMMENDED_PARALLEL_WORKTREES = 3;

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

function safeRealpath(targetPath) {
  try {
    return NodeFS.realpathSync(targetPath);
  } catch {
    return NodePath.resolve(targetPath);
  }
}

function isPathInside(childPath, parentPath) {
  const rel = NodePath.relative(safeRealpath(parentPath), safeRealpath(childPath));
  return rel === "" || (!rel.startsWith("..") && !NodePath.isAbsolute(rel));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLiveSetupPid(worktreePath) {
  const markerPath = NodePath.join(worktreePath, ".t3", "setup-running");
  if (!NodeFS.existsSync(markerPath)) return null;
  try {
    const raw = NodeFS.readFileSync(markerPath, "utf8").trim();
    const match = raw.match(/^\d+/);
    if (!match) return null;
    const pid = Number.parseInt(match[0], 10);
    return isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function listWorktrees(cwd) {
  const raw = run("git", ["worktree", "list", "--porcelain"], { cwd });
  if (!raw) return [];
  const blocks = raw.split(/\n\n+/).filter(Boolean);
  return blocks.map((block, index) => {
    const entry = {
      path: "",
      realPath: "",
      head: "",
      branch: null,
      isDetached: false,
      isBare: false,
      isLocked: false,
      isPrunable: false,
      isMain: index === 0,
    };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        entry.path = line.slice("worktree ".length);
        entry.realPath = safeRealpath(entry.path);
      } else if (line.startsWith("HEAD ")) {
        entry.head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        entry.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (line === "detached") {
        entry.isDetached = true;
      } else if (line === "bare") {
        entry.isBare = true;
      } else if (line === "locked" || line.startsWith("locked ")) {
        entry.isLocked = true;
      } else if (line === "prunable" || line.startsWith("prunable ")) {
        entry.isPrunable = true;
      }
    }
    return entry;
  });
}

function readActiveOpenSpecChanges(worktreePath) {
  const changesDir = NodePath.join(worktreePath, "openspec", "changes");
  if (!NodeFS.existsSync(changesDir)) return [];
  const entries = NodeFS.readdirSync(changesDir, { withFileTypes: true });
  return entries
    .filter((dirent) => dirent.isDirectory() && dirent.name !== "archive")
    .filter((dirent) => {
      const dirPath = NodePath.join(changesDir, dirent.name);
      return (
        NodeFS.existsSync(NodePath.join(dirPath, ".openspec.yaml")) ||
        NodeFS.existsSync(NodePath.join(dirPath, "proposal.md"))
      );
    })
    .map((dirent) => dirent.name)
    .sort();
}

function assertForkOrigin(repoRoot) {
  const originUrl = run("git", ["remote", "get-url", "origin"], { cwd: repoRoot, allowFail: true });
  if (!originUrl || !originUrl.includes(FORK_REPO)) {
    fail(`Expected 'origin' remote to point to ${FORK_REPO}, got: ${originUrl ?? "(none)"}.`, 1);
  }
}

function resolveMainRoot(cwd) {
  const worktrees = listWorktrees(cwd);
  if (worktrees.length === 0 || !worktrees[0].path) {
    fail("Must be run inside a Git repository.", 1);
  }
  return { mainRoot: worktrees[0].path, worktrees };
}

function printUsage() {
  console.error(
    "Usage: node fork/scripts/worktree-task.mjs <command> [options]\n" +
      "\n" +
      "Commands:\n" +
      "  open <topic>     Create sibling feature worktree (../<repo>-<topic>) from origin/lmx-lab\n" +
      "                   Options: --prefix <feat|fix|chore|docs|refactor|perf|test>\n" +
      "                            --base <ref>  --worktree <path>\n" +
      "                            --no-fetch  --no-install  --dry-run\n" +
      "  status           Show all worktrees, dirty count, ahead/behind, deps, and OpenSpec changes\n" +
      "                   Options: --fetch  --json\n" +
      "  close <target>   Safely remove a linked worktree (by topic, branch, basename, or path)\n" +
      "                   Options: --force  --keep-branch  --dry-run\n" +
      "\n" +
      "Global options:\n" +
      "  -h, --help       Show this help\n",
  );
}

function handleOpen(args, cwd) {
  let prefix = DEFAULT_PREFIX;
  let baseRef = DEFAULT_BASE;
  let explicitWorktree;
  let noFetch = false;
  let noInstall = false;
  let dryRun = false;
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--no-fetch") {
      noFetch = true;
    } else if (arg === "--no-install") {
      noInstall = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--prefix") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) fail("--prefix requires a value.", 2);
      prefix = next;
      i += 1;
    } else if (arg === "--base") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) fail("--base requires a ref.", 2);
      baseRef = next;
      i += 1;
    } else if (arg === "--worktree") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) fail("--worktree requires a directory path.", 2);
      explicitWorktree = next;
      i += 1;
    } else if (arg.startsWith("-")) {
      fail(`Unknown option for 'open': ${arg}`, 2);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    fail("open requires exactly one <topic> slug (e.g. 'usage-limits-intelligence').", 2);
  }

  const topic = positional[0];
  if (!TOPIC_PATTERN.test(topic)) {
    fail(
      `Invalid topic slug "${topic}". Use lowercase alphanumeric + hyphens (2-63 chars, e.g. "usage-limits").`,
      2,
    );
  }
  if (PROTECTED_BRANCHES.has(topic) || topic.startsWith("sync-upstream")) {
    fail(
      `Topic "${topic}" is reserved; use sync-upstream.mjs for upstream syncs and never target protected branches.`,
      2,
    );
  }
  if (!ALLOWED_PREFIXES.has(prefix)) {
    fail(`Invalid --prefix "${prefix}". Allowed prefixes: ${[...ALLOWED_PREFIXES].join(", ")}.`, 2);
  }

  const { mainRoot } = resolveMainRoot(cwd);
  assertForkOrigin(mainRoot);

  const branchName = `${prefix}/${topic}`;
  const mainRepoName = NodePath.basename(mainRoot);
  const worktreePath = explicitWorktree
    ? NodePath.resolve(cwd, explicitWorktree)
    : NodePath.resolve(mainRoot, "..", `${mainRepoName}-${topic}`);

  if (!noFetch && !dryRun && baseRef.startsWith("origin/")) {
    const remoteBranch = baseRef.slice("origin/".length);
    console.log(`Fetching origin/${remoteBranch}...`);
    run("git", ["fetch", "origin", remoteBranch, "--prune"], { cwd: mainRoot });
  }

  const baseSha = run("git", ["rev-parse", "--verify", `${baseRef}^{commit}`], {
    cwd: mainRoot,
    allowFail: true,
  });
  if (!baseSha) {
    fail(`Could not resolve base ref "${baseRef}". Run 'git fetch origin' or check the ref.`, 1);
  }

  const existingBranch = run("git", ["branch", "--list", branchName], { cwd: mainRoot });
  if (existingBranch) {
    fail(`Local branch '${branchName}' already exists. Pick another topic or delete it first.`, 1);
  }
  if (NodeFS.existsSync(worktreePath)) {
    fail(`Worktree path already exists: ${worktreePath}`, 1);
  }

  if (dryRun) {
    console.log(`DRY-RUN  Would create worktree:`);
    console.log(`  Path:    ${worktreePath}`);
    console.log(`  Branch:  ${branchName}`);
    console.log(`  Base:    ${baseRef} (${baseSha.slice(0, 10)})`);
    console.log(
      `  Install: ${noInstall ? "skipped (--no-install)" : "vp i (unless .t3/setup-running is live)"}`,
    );
    return;
  }

  console.log(`Creating worktree ${worktreePath} (${branchName} @ ${baseSha.slice(0, 10)})...`);
  run("git", ["worktree", "add", worktreePath, "-b", branchName, baseRef], { cwd: mainRoot });

  let installStatus = "skipped (--no-install)";
  if (!noInstall) {
    const livePid = readLiveSetupPid(worktreePath);
    if (livePid !== null) {
      installStatus = `skipped (live .t3/setup-running PID ${livePid})`;
      console.log(`INFO  ${installStatus}.`);
    } else {
      console.log("Running vp i in new worktree...");
      NodeChildProcess.execFileSync("vp", ["i"], { cwd: worktreePath, stdio: "inherit" });
      installStatus = "vp i completed";
    }
  }

  console.log("");
  console.log(`PASS  Worktree ready at ${worktreePath}`);
  console.log(`  Branch:  ${branchName}`);
  console.log(`  Base:    ${baseRef} (${baseSha.slice(0, 10)})`);
  console.log(`  Deps:    ${installStatus}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  cd ${worktreePath}`);
  console.log("  # Never touch live ~/.t3/userdata; linked worktrees isolate dev state under .t3/");
}

function handleStatus(args, cwd) {
  let shouldFetch = false;
  let jsonOutput = false;

  for (const arg of args) {
    if (arg === "--fetch") {
      shouldFetch = true;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else {
      fail(`Unknown option for 'status': ${arg}`, 2);
    }
  }

  const { mainRoot, worktrees } = resolveMainRoot(cwd);

  if (shouldFetch) {
    run("git", ["fetch", "origin", DEFAULT_BRANCH, "--prune"], { cwd: mainRoot });
  }

  const baseSha = run("git", ["rev-parse", "--verify", `${DEFAULT_BASE}^{commit}`], {
    cwd: mainRoot,
    allowFail: true,
  });

  const rows = worktrees.map((wt) => {
    const exists = NodeFS.existsSync(wt.path);
    const porcelain = exists
      ? (run("git", ["status", "--porcelain"], { cwd: wt.path, allowFail: true }) ?? "")
      : "";
    const dirtyCount = porcelain ? porcelain.split("\n").filter(Boolean).length : 0;

    let ahead = null;
    let behind = null;
    if (exists && baseSha && wt.head) {
      const counts = run(
        "git",
        ["rev-list", "--left-right", "--count", `${baseSha}...${wt.head}`],
        {
          cwd: wt.path,
          allowFail: true,
        },
      );
      if (counts) {
        const [behindRaw, aheadRaw] = counts.split(/\s+/);
        behind = Number.parseInt(behindRaw, 10);
        ahead = Number.parseInt(aheadRaw, 10);
      }
    }

    return {
      path: wt.path,
      name: NodePath.basename(wt.path),
      isMain: wt.isMain,
      branch: wt.branch,
      head: wt.head.slice(0, 10),
      dirtyCount,
      ahead,
      behind,
      depsReady: exists && NodeFS.existsSync(NodePath.join(wt.path, "node_modules")),
      setupRunningPid: exists ? readLiveSetupPid(wt.path) : null,
      activeChanges: exists ? readActiveOpenSpecChanges(wt.path) : [],
      prunable: wt.isPrunable || !exists,
    };
  });

  const activeLinkedCount = rows.filter((row) => !row.isMain && !row.prunable).length;

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          mainRoot,
          baseRef: baseSha ? DEFAULT_BASE : null,
          activeLinkedCount,
          worktrees: rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Worktrees (main: ${mainRoot}, active linked: ${activeLinkedCount}):`);
  for (const row of rows) {
    const role = row.isMain ? "main" : "worktree";
    const branchLabel = row.branch ?? "(detached)";
    const dirtyLabel = row.dirtyCount > 0 ? `dirty:${row.dirtyCount}` : "clean";
    const syncLabel =
      row.ahead !== null && row.behind !== null ? `+${row.ahead}/-${row.behind}` : "n/a";
    const depsLabel = row.setupRunningPid
      ? `setup-pid:${row.setupRunningPid}`
      : row.depsReady
        ? "deps:ok"
        : "deps:missing";
    const changesLabel =
      row.activeChanges.length > 0 ? `openspec:[${row.activeChanges.join(",")}]` : "openspec:-";
    console.log(
      `  [${role}] ${row.name}  branch=${branchLabel}  head=${row.head}  ${dirtyLabel}  ${syncLabel}  ${depsLabel}  ${changesLabel}`,
    );
  }

  if (activeLinkedCount > MAX_RECOMMENDED_PARALLEL_WORKTREES) {
    console.log("");
    console.log(
      `WARN  ${activeLinkedCount} linked worktrees active (recommended parallel Wave cap: ${MAX_RECOMMENDED_PARALLEL_WORKTREES}). Close merged worktrees with 'close <topic>'.`,
    );
  }
}

function handleClose(args, cwd) {
  let force = false;
  let keepBranch = false;
  let dryRun = false;
  const positional = [];

  for (const arg of args) {
    if (arg === "--force") {
      force = true;
    } else if (arg === "--keep-branch") {
      keepBranch = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("-")) {
      fail(`Unknown option for 'close': ${arg}`, 2);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    fail("close requires exactly one <target> (topic, branch, directory basename, or path).", 2);
  }

  const target = positional[0];
  const { mainRoot, worktrees } = resolveMainRoot(cwd);
  const mainName = NodePath.basename(mainRoot);
  const resolvedTarget = safeRealpath(NodePath.resolve(cwd, target));

  const matches = worktrees.filter((wt) => {
    const baseName = NodePath.basename(wt.path);
    return (
      wt.realPath === resolvedTarget ||
      baseName === target ||
      baseName === `${mainName}-${target}` ||
      wt.branch === target ||
      (wt.branch !== null && wt.branch.endsWith(`/${target}`))
    );
  });

  if (matches.length === 0) {
    const available = worktrees
      .filter((wt) => !wt.isMain)
      .map((wt) => `${NodePath.basename(wt.path)} (${wt.branch ?? "detached"})`)
      .join(", ");
    fail(`No worktree matched "${target}". Active linked worktrees: ${available || "(none)"}.`, 1);
  }
  if (matches.length > 1) {
    const names = matches.map((wt) => `${wt.path} (${wt.branch ?? "detached"})`).join(", ");
    fail(`Target "${target}" is ambiguous (${names}). Pass an exact branch or path.`, 1);
  }

  const match = matches[0];
  if (match.isMain) {
    fail(`Refusing to close the main repository worktree: ${match.path}`, 1);
  }
  if (match.branch && PROTECTED_BRANCHES.has(match.branch)) {
    fail(`Refusing to close protected branch '${match.branch}'.`, 1);
  }
  if (isPathInside(cwd, match.path)) {
    fail(
      `Current working directory (${cwd}) is inside target worktree ${match.path}. Switch directory first.`,
      1,
    );
  }

  const porcelain = NodeFS.existsSync(match.path)
    ? (run("git", ["status", "--porcelain"], { cwd: match.path, allowFail: true }) ?? "")
    : "";
  const dirtyLines = porcelain ? porcelain.split("\n").filter(Boolean) : [];
  if (dirtyLines.length > 0 && !force) {
    fail(
      `Refusing to close dirty worktree ${match.path} (${dirtyLines.length} uncommitted change(s)). Commit/stash first or pass --force.`,
      1,
    );
  }

  const baseSha = run("git", ["rev-parse", "--verify", `${DEFAULT_BASE}^{commit}`], {
    cwd: mainRoot,
    allowFail: true,
  });
  const isMergedIntoBase =
    match.branch !== null &&
    baseSha !== null &&
    run("git", ["merge-base", "--is-ancestor", `refs/heads/${match.branch}`, baseSha], {
      cwd: mainRoot,
      allowFail: true,
    }) !== null;

  if (dryRun) {
    console.log("DRY-RUN  Would close worktree:");
    console.log(`  Path:   ${match.path}`);
    console.log(`  Branch: ${match.branch ?? "(detached)"}`);
    if (keepBranch || !match.branch) {
      console.log("  Branch action: keep");
    } else if (force) {
      console.log(`  Branch action: force-delete (git branch -D ${match.branch})`);
    } else if (isMergedIntoBase) {
      console.log(`  Branch action: delete merged branch (${match.branch})`);
    } else {
      console.log(
        `  Branch action: keep (not an ancestor of ${DEFAULT_BASE}; pass --force after squash-merge)`,
      );
    }
    return;
  }

  const removeArgs = force
    ? ["worktree", "remove", "--force", match.path]
    : ["worktree", "remove", match.path];
  run("git", removeArgs, { cwd: mainRoot });
  run("git", ["worktree", "prune"], { cwd: mainRoot });

  let branchSummary = "none (detached)";
  if (match.branch) {
    if (keepBranch) {
      branchSummary = `kept '${match.branch}' (--keep-branch)`;
    } else if (force) {
      run("git", ["branch", "-D", match.branch], { cwd: mainRoot });
      branchSummary = `deleted '${match.branch}' (--force)`;
    } else if (isMergedIntoBase) {
      // Branch is already an ancestor of origin/lmx-lab even if main worktree HEAD points elsewhere.
      run("git", ["branch", "-D", match.branch], { cwd: mainRoot });
      branchSummary = `deleted merged '${match.branch}'`;
    } else {
      const deletedViaSafeFlag = run("git", ["branch", "-d", match.branch], {
        cwd: mainRoot,
        allowFail: true,
      });
      if (deletedViaSafeFlag !== null) {
        branchSummary = `deleted '${match.branch}'`;
      } else {
        branchSummary = `kept unmerged/squash-merged '${match.branch}' (run: git branch -D ${match.branch})`;
      }
    }
  }

  console.log(`PASS  Closed worktree ${match.path}`);
  console.log(`  Branch: ${branchSummary}`);
}

const rawArgs = NodeProcess.argv.slice(2);
if (rawArgs.length === 0 || rawArgs[0] === "-h" || rawArgs[0] === "--help") {
  printUsage();
  NodeProcess.exit(rawArgs.length === 0 ? 2 : 0);
}

const [command, ...rest] = rawArgs;
if (rest.includes("-h") || rest.includes("--help")) {
  printUsage();
  NodeProcess.exit(0);
}

const cwd = NodeProcess.cwd();
if (command === "open") {
  handleOpen(rest, cwd);
} else if (command === "status") {
  handleStatus(rest, cwd);
} else if (command === "close") {
  handleClose(rest, cwd);
} else {
  fail(`Unknown command "${command}". Expected one of: open, status, close.`, 2);
}
