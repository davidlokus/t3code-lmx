import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { afterEach, assert, describe, it } from "vite-plus/test";

const SCRIPT_PATH = NodeURL.fileURLToPath(new URL("./worktree-task.mjs", import.meta.url));
const createdRoots = [];

function runGit(args, cwd) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runScript(args, { cwd, env } = {}) {
  return NodeChildProcess.spawnSync(NodeProcess.execPath, [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: env ?? NodeProcess.env,
  });
}

function createFixtureRepo({ originSegment = "davidlokus/t3code-lmx.git" } = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3lab-wt-test-"));
  createdRoots.push(root);

  const remotePath = NodePath.join(root, "remotes", originSegment);
  const mainRepo = NodePath.join(root, "t3code-lmx");
  NodeFS.mkdirSync(remotePath, { recursive: true });
  NodeFS.mkdirSync(mainRepo, { recursive: true });

  runGit(["init", "--bare", remotePath], root);
  runGit(["init", "-b", "lmx-lab"], mainRepo);
  runGit(["config", "user.name", "T3 Lab Test"], mainRepo);
  runGit(["config", "user.email", "t3lab-test@example.com"], mainRepo);
  NodeFS.writeFileSync(NodePath.join(mainRepo, "README.md"), "fork base\n", "utf8");
  runGit(["add", "README.md"], mainRepo);
  runGit(["commit", "-m", "initial commit"], mainRepo);
  runGit(["remote", "add", "origin", remotePath], mainRepo);
  runGit(["push", "-u", "origin", "lmx-lab"], mainRepo);

  const fakeBin = NodePath.join(root, "fake-bin");
  NodeFS.mkdirSync(fakeBin, { recursive: true });
  const vpLogPath = NodePath.join(root, "vp-invocations.log");
  const fakeVpPath = NodePath.join(fakeBin, "vp");
  NodeFS.writeFileSync(
    fakeVpPath,
    `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> "${vpLogPath}"\nmkdir -p "$PWD/node_modules"\n`,
    { mode: 0o755 },
  );

  const envWithFakeVp = {
    ...NodeProcess.env,
    PATH: `${fakeBin}:${NodeProcess.env.PATH ?? ""}`,
  };

  return { root, remotePath, mainRepo, vpLogPath, envWithFakeVp };
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop();
    if (dir) NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("fork/scripts/worktree-task.mjs", () => {
  it("opens an adjacent sibling worktree, runs vp i, and reports rich JSON status", () => {
    const { root, mainRepo, vpLogPath, envWithFakeVp } = createFixtureRepo();

    const dryRun = runScript(["open", "limits-core", "--dry-run", "--no-fetch"], {
      cwd: mainRepo,
      env: envWithFakeVp,
    });
    assert.strictEqual(dryRun.status, 0, dryRun.stderr);
    assert.include(dryRun.stdout, "DRY-RUN");
    assert.include(dryRun.stdout, "feat/limits-core");
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, "t3code-lmx-limits-core")));

    const openRes = runScript(["open", "limits-core", "--prefix", "chore"], {
      cwd: mainRepo,
      env: envWithFakeVp,
    });
    assert.strictEqual(openRes.status, 0, openRes.stderr);

    const wtPath = NodePath.join(root, "t3code-lmx-limits-core");
    assert.isTrue(NodeFS.existsSync(wtPath));
    assert.strictEqual(runGit(["branch", "--show-current"], wtPath), "chore/limits-core");

    const vpLog = NodeFS.readFileSync(vpLogPath, "utf8").trim();
    assert.include(vpLog, `${NodeFS.realpathSync(wtPath)}|i`);

    // Add an active OpenSpec change and an untracked file to verify status reporting.
    const changeDir = NodePath.join(wtPath, "openspec", "changes", "limits-core");
    NodeFS.mkdirSync(changeDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(changeDir, "proposal.md"), "# Proposal\n", "utf8");
    NodeFS.mkdirSync(NodePath.join(wtPath, "openspec", "changes", "archive", "old"), {
      recursive: true,
    });

    const statusRes = runScript(["status", "--json"], { cwd: wtPath, env: envWithFakeVp });
    assert.strictEqual(statusRes.status, 0, statusRes.stderr);
    const parsed = JSON.parse(statusRes.stdout);
    assert.strictEqual(parsed.activeLinkedCount, 1);
    assert.strictEqual(parsed.worktrees.length, 2);

    const linked = parsed.worktrees.find((row) => !row.isMain);
    assert.ok(linked);
    assert.strictEqual(linked.branch, "chore/limits-core");
    assert.isTrue(linked.depsReady);
    assert.deepStrictEqual(linked.activeChanges, ["limits-core"]);
    assert.isAtLeast(linked.dirtyCount, 1);
  });

  it("skips vp i when .t3/setup-running names a live PID", () => {
    const { root, mainRepo, vpLogPath, envWithFakeVp } = createFixtureRepo();

    // Simulate a live setup hook creating .t3/setup-running during worktree checkout.
    const hookPath = NodePath.join(mainRepo, ".git", "hooks", "post-checkout");
    NodeFS.writeFileSync(
      hookPath,
      `#!/bin/sh\nmkdir -p .t3\necho "${NodeProcess.pid}" > .t3/setup-running\n`,
      { mode: 0o755 },
    );

    const openRes = runScript(["open", "live-setup", "--no-fetch"], {
      cwd: mainRepo,
      env: envWithFakeVp,
    });
    assert.strictEqual(openRes.status, 0, openRes.stderr);
    assert.include(openRes.stdout, `live .t3/setup-running PID ${NodeProcess.pid}`);
    assert.isFalse(NodeFS.existsSync(vpLogPath));

    const statusRes = runScript(["status", "--json"], { cwd: mainRepo, env: envWithFakeVp });
    assert.strictEqual(statusRes.status, 0, statusRes.stderr);
    const linked = JSON.parse(statusRes.stdout).worktrees.find((row) => !row.isMain);
    assert.strictEqual(linked.setupRunningPid, NodeProcess.pid);
    assert.isTrue(NodeFS.existsSync(NodePath.join(root, "t3code-lmx-live-setup")));
  });

  it("rejects invalid topics, reserved names, unknown prefixes, and non-fork origins", () => {
    const { mainRepo, envWithFakeVp } = createFixtureRepo();

    const badTopic = runScript(["open", "Bad_Topic!", "--no-fetch", "--no-install"], {
      cwd: mainRepo,
      env: envWithFakeVp,
    });
    assert.strictEqual(badTopic.status, 2);
    assert.include(badTopic.stderr, "Invalid topic slug");

    const reservedTopic = runScript(["open", "lmx-lab", "--no-fetch", "--no-install"], {
      cwd: mainRepo,
      env: envWithFakeVp,
    });
    assert.strictEqual(reservedTopic.status, 2);
    assert.include(reservedTopic.stderr, "reserved");

    const syncTopic = runScript(["open", "sync-upstream-foo", "--no-fetch", "--no-install"], {
      cwd: mainRepo,
      env: envWithFakeVp,
    });
    assert.strictEqual(syncTopic.status, 2);
    assert.include(syncTopic.stderr, "sync-upstream.mjs");

    const badPrefix = runScript(
      ["open", "valid-topic", "--prefix", "release", "--no-fetch", "--no-install"],
      { cwd: mainRepo, env: envWithFakeVp },
    );
    assert.strictEqual(badPrefix.status, 2);
    assert.include(badPrefix.stderr, "Invalid --prefix");

    const wrongOrigin = createFixtureRepo({ originSegment: "pingdotgg/t3code.git" });
    const rejectedOrigin = runScript(["open", "valid-topic", "--no-fetch", "--no-install"], {
      cwd: wrongOrigin.mainRepo,
      env: wrongOrigin.envWithFakeVp,
    });
    assert.strictEqual(rejectedOrigin.status, 1);
    assert.include(rejectedOrigin.stderr, "davidlokus/t3code-lmx");
  });

  it("protects main worktree, cwd-inside-target, dirty trees, and unmerged branches on close", () => {
    const { root, mainRepo, envWithFakeVp } = createFixtureRepo();

    const openRes = runScript(["open", "close-guard", "--no-fetch", "--no-install"], {
      cwd: mainRepo,
      env: envWithFakeVp,
    });
    assert.strictEqual(openRes.status, 0, openRes.stderr);
    const wtPath = NodePath.join(root, "t3code-lmx-close-guard");

    // Refuse closing main worktree.
    const closeMain = runScript(["close", "t3code-lmx"], { cwd: mainRepo, env: envWithFakeVp });
    assert.strictEqual(closeMain.status, 1);
    assert.include(closeMain.stderr, "main repository worktree");

    // Refuse closing when cwd is inside target worktree.
    const closeInside = runScript(["close", "close-guard"], { cwd: wtPath, env: envWithFakeVp });
    assert.strictEqual(closeInside.status, 1);
    assert.include(closeInside.stderr, "Current working directory");

    // Refuse closing when target worktree has uncommitted changes.
    NodeFS.writeFileSync(NodePath.join(wtPath, "dirty.txt"), "wip\n", "utf8");
    const closeDirty = runScript(["close", "close-guard"], { cwd: mainRepo, env: envWithFakeVp });
    assert.strictEqual(closeDirty.status, 1);
    assert.include(closeDirty.stderr, "dirty worktree");
    assert.isTrue(NodeFS.existsSync(wtPath));

    // Clean commit that is NOT yet an ancestor of origin/lmx-lab (simulates squash-merged or local commit):
    // close removes worktree safely and retains branch until --force or git branch -D.
    runGit(["add", "dirty.txt"], wtPath);
    runGit(["commit", "-m", "local feature commit"], wtPath);

    const closeUnmerged = runScript(["close", "close-guard"], {
      cwd: mainRepo,
      env: envWithFakeVp,
    });
    assert.strictEqual(closeUnmerged.status, 0, closeUnmerged.stderr);
    assert.isFalse(NodeFS.existsSync(wtPath));
    assert.include(closeUnmerged.stdout, "kept unmerged/squash-merged");
    assert.strictEqual(
      runGit(["branch", "--list", "feat/close-guard"], mainRepo),
      "feat/close-guard",
    );
  });

  it("deletes merged branches on close and supports --force and --keep-branch", () => {
    const { root, mainRepo, envWithFakeVp } = createFixtureRepo();

    // 1. Clean branch pointing directly at origin/lmx-lab (merged) -> worktree + branch removed.
    assert.strictEqual(
      runScript(["open", "merged-case", "--no-fetch", "--no-install"], {
        cwd: mainRepo,
        env: envWithFakeVp,
      }).status,
      0,
    );
    const closeMerged = runScript(["close", "merged-case"], { cwd: mainRepo, env: envWithFakeVp });
    assert.strictEqual(closeMerged.status, 0, closeMerged.stderr);
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, "t3code-lmx-merged-case")));
    assert.strictEqual(runGit(["branch", "--list", "feat/merged-case"], mainRepo), "");

    // 2. --keep-branch retains branch even when merged.
    assert.strictEqual(
      runScript(["open", "keep-case", "--no-fetch", "--no-install"], {
        cwd: mainRepo,
        env: envWithFakeVp,
      }).status,
      0,
    );
    const closeKeep = runScript(["close", "keep-case", "--keep-branch"], {
      cwd: mainRepo,
      env: envWithFakeVp,
    });
    assert.strictEqual(closeKeep.status, 0, closeKeep.stderr);
    assert.isFalse(NodeFS.existsSync(NodePath.join(root, "t3code-lmx-keep-case")));
    assert.strictEqual(runGit(["branch", "--list", "feat/keep-case"], mainRepo), "feat/keep-case");

    // 3. --force removes dirty worktree and force-deletes unmerged branch.
    assert.strictEqual(
      runScript(["open", "force-case", "--no-fetch", "--no-install"], {
        cwd: mainRepo,
        env: envWithFakeVp,
      }).status,
      0,
    );
    const forceWt = NodePath.join(root, "t3code-lmx-force-case");
    NodeFS.writeFileSync(NodePath.join(forceWt, "untracked.txt"), "discard\n", "utf8");
    const closeForce = runScript(["close", "force-case", "--force"], {
      cwd: mainRepo,
      env: envWithFakeVp,
    });
    assert.strictEqual(closeForce.status, 0, closeForce.stderr);
    assert.isFalse(NodeFS.existsSync(forceWt));
    assert.strictEqual(runGit(["branch", "--list", "feat/force-case"], mainRepo), "");
  });
});
