// @effect-diagnostics nodeBuiltinImport:off - tests seed isolated config snapshots and cache files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { UsageLimitSourceAccount } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { readClaudeSwapUsage } from "./claudeSwap.ts";

const decodeAccounts = Schema.decodeSync(Schema.Array(UsageLimitSourceAccount));

const NOW = Date.parse("2026-08-01T12:00:00Z");
const ACCOUNT = {
  accountUuid: "saved-account",
  organizationUuid: "saved-org",
  emailAddress: "saved@example.test",
  planDisplayName: "Max",
};
const READING = {
  email: "SAVED@example.test",
  organizationUuid: "saved-org",
  fetchedAt: NOW / 1_000 - 60,
  lastError: "http-429",
  lastGood: {
    five_hour: { pct: 17.5, resets_at: "2026-08-01T16:00:00Z" },
    seven_day: { pct: 42, resets_at: null },
    scoped: [
      { name: " Fable ", pct: 90 },
      { name: "Other", pct: 4 },
    ],
  },
};

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

async function writeSlot(home: string, slot: number, account = ACCOUNT) {
  const configs = NodePath.join(home, ".claude-swap-backup", "configs");
  await NodeFSP.mkdir(configs, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(configs, `.claude-config-${slot}-${account.emailAddress}.json`),
    JSON.stringify({ oauthAccount: account }),
  );
}

async function writeCache(
  home: string,
  accounts: Record<string, unknown>,
  schemaVersion: string | number = 2,
) {
  const cache = NodePath.join(home, ".claude-swap-backup", "cache");
  await NodeFSP.mkdir(cache, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(cache, "usage.json"),
    JSON.stringify({ schemaVersion, accounts }),
  );
}

describe("ClaudeSwap cached usage", () => {
  it("maps last-good session, weekly, and scoped windows with the failed-poll warning", async () => {
    await withTempDir("claude-swap-usage-", async (home) => {
      await writeSlot(home, 1);
      await writeCache(home, { 1: READING });

      const accounts = await readClaudeSwapUsage({ home, nowMs: NOW });
      expect(accounts).toMatchObject([
        {
          driver: "claudeAgent",
          email: "saved@example.test",
          plan: "Max",
          workspaceId: "saved-org",
          usageLimits: {
            checkedAt: "2026-08-01T11:59:00.000Z",
            windows: [
              {
                id: "five_hour",
                kind: "session",
                usedPercent: 17.5,
                windowDurationMins: 300,
                resetsAt: "2026-08-01T16:00:00.000Z",
              },
              { id: "seven_day", kind: "weekly", usedPercent: 42, windowDurationMins: 10_080 },
              { id: "seven_day_fable", kind: "weekly", usedPercent: 90, scopeLabel: "Fable" },
              { id: "seven_day_other", kind: "weekly", usedPercent: 4, scopeLabel: "Other" },
            ],
            serviceNotice: { message: "http-429", severity: "warning" },
          },
        },
      ]);
      expect(accounts[0]?.usageLimits.unavailable).toBeUndefined();
      expect(decodeAccounts(accounts)).toEqual(accounts);
    });
  });

  it("excludes active accounts matching user+org or workspace-less identity, while keeping distinct orgs for one user and distinct seats in a shared org", async () => {
    await withTempDir("claude-swap-usage-", async (home) => {
      await NodeFSP.writeFile(
        NodePath.join(home, ".claude.json"),
        JSON.stringify({
          oauthAccount: {
            accountUuid: "ACTIVE-UUID",
            organizationUuid: "active-org",
            emailAddress: "ACTIVE@example.test",
          },
        }),
      );
      await Promise.all([
        // Slot 1: same login, different organization -> keep.
        writeSlot(home, 1, {
          ...ACCOUNT,
          accountUuid: "active-uuid",
          organizationUuid: "second-org",
          emailAddress: "active@example.test",
        }),
        // Slot 2: distinct teammate seat in the same shared organization -> keep.
        writeSlot(home, 2, {
          ...ACCOUNT,
          accountUuid: "teammate-uuid",
          organizationUuid: "ACTIVE-ORG",
          emailAddress: "teammate@example.test",
        }),
        // Slot 3: legacy org-less slot sharing active email -> exclude.
        writeSlot(home, 3, {
          accountUuid: "legacy-uuid",
          organizationUuid: "",
          emailAddress: "active@example.test",
          planDisplayName: "Max",
        }),
        // Slot 4: unrelated saved account -> keep.
        writeSlot(home, 4),
        // Slot 5: exact same user and org as active ~/.claude.json -> exclude.
        writeSlot(home, 5, {
          ...ACCOUNT,
          accountUuid: "active-uuid",
          organizationUuid: "ACTIVE-ORG",
          emailAddress: "active@example.test",
        }),
      ]);
      await writeCache(home, {
        1: { ...READING, email: "active@example.test", organizationUuid: "second-org" },
        2: { ...READING, email: "teammate@example.test", organizationUuid: "active-org" },
        4: READING,
        5: { ...READING, email: "active@example.test", organizationUuid: "active-org" },
      });

      const options = { home, nowMs: NOW };
      expect(
        (await readClaudeSwapUsage(options))
          .map((account) => `${account.email}@${account.workspaceId}`)
          .sort(),
      ).toEqual([
        "active@example.test@second-org",
        "saved@example.test@saved-org",
        "teammate@example.test@active-org",
      ]);
      expect(
        (
          await readClaudeSwapUsage({
            ...options,
            activeIdentities: [
              { email: "SAVED@example.test" },
              { organizationUuid: "active-org" },
              { accountUuid: "ACTIVE-UUID" },
            ],
          })
        ).map((account) => account.email),
      ).toEqual(["active@example.test"]);
    });
  });

  it("follows valid symlinks for ~/.claude.json, slot configs, and cache, and fails closed on dangling ~/.claude.json", async () => {
    await withTempDir("claude-swap-symlink-", async (home) => {
      const dotfiles = NodePath.join(home, "dotfiles");
      const configs = NodePath.join(home, ".claude-swap-backup", "configs");
      const cache = NodePath.join(home, ".claude-swap-backup", "cache");
      await Promise.all([
        NodeFSP.mkdir(dotfiles, { recursive: true }),
        NodeFSP.mkdir(configs, { recursive: true }),
        NodeFSP.mkdir(cache, { recursive: true }),
      ]);

      const activeTarget = NodePath.join(dotfiles, "claude.json");
      const slotTarget = NodePath.join(dotfiles, "slot-1.json");
      const cacheTarget = NodePath.join(dotfiles, "usage.json");
      await Promise.all([
        NodeFSP.writeFile(
          activeTarget,
          JSON.stringify({
            oauthAccount: {
              accountUuid: "active-uuid",
              organizationUuid: "active-org",
              emailAddress: "active@example.test",
            },
          }),
        ),
        NodeFSP.writeFile(slotTarget, JSON.stringify({ oauthAccount: ACCOUNT })),
        NodeFSP.writeFile(
          cacheTarget,
          JSON.stringify({ schemaVersion: 2, accounts: { 1: READING } }),
        ),
      ]);
      await Promise.all([
        NodeFSP.symlink(activeTarget, NodePath.join(home, ".claude.json")),
        NodeFSP.symlink(
          slotTarget,
          NodePath.join(configs, `.claude-config-1-${ACCOUNT.emailAddress}.json`),
        ),
        NodeFSP.symlink(cacheTarget, NodePath.join(cache, "usage.json")),
      ]);

      const accounts = await readClaudeSwapUsage({ home, nowMs: NOW });
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        email: "saved@example.test",
        workspaceId: "saved-org",
      });
      expect(accounts[0]?.usageLimits.windows[0]).toMatchObject({
        id: "five_hour",
        usedPercent: 17.5,
      });

      // Dangling ~/.claude.json symlink cannot prove active identity -> fail closed.
      await NodeFSP.unlink(activeTarget);
      expect(await readClaudeSwapUsage({ home, nowMs: NOW })).toEqual([]);
    });
  });

  it.each([
    { email: "someone-else@example.test" },
    { organizationUuid: "previous-org" },
    { organizationUuid: null },
  ])("rejects a slot row whose identity cannot match: %j", async (identity) => {
    await withTempDir("claude-swap-usage-", async (home) => {
      await writeSlot(home, 1);
      await writeCache(home, { 1: { ...READING, ...identity } });
      const [account] = await readClaudeSwapUsage({ home, nowMs: NOW });
      expect(account?.usageLimits).toMatchObject({
        windows: [],
        unavailable: { reason: "probeFailed" },
      });
      expect(account?.usageLimits.unavailable?.message).not.toContain("http-429");
      expect(account?.usageLimits.serviceNotice).toBeUndefined();
    });
  });

  it.each([
    { age: 0, fresh: true },
    { age: 7_200, fresh: true },
    { age: 7_201, fresh: false },
    { age: -1, fresh: false },
    { age: null, fresh: false },
  ])("checks both sides of the 2h freshness window: %j", async ({ age, fresh }) => {
    await withTempDir("claude-swap-usage-", async (home) => {
      await writeSlot(home, 1);
      await writeCache(home, {
        1: { ...READING, fetchedAt: age === null ? null : NOW / 1_000 - age },
      });
      const [account] = await readClaudeSwapUsage({ home, nowMs: NOW });
      if (fresh) {
        expect(account?.usageLimits.windows[0]?.usedPercent).toBe(17.5);
        expect(account?.usageLimits.serviceNotice).toMatchObject({
          message: "http-429",
          severity: "warning",
        });
      } else {
        expect(account?.usageLimits).toMatchObject({
          windows: [],
          unavailable: { reason: "probeFailed", message: "http-429" },
        });
      }
    });
  });

  it.each([undefined, 1, 3, "2"])(
    "reports unavailable for a missing or unsupported cache: %s",
    async (version) => {
      await withTempDir("claude-swap-usage-", async (home) => {
        await writeSlot(home, 1);
        if (version !== undefined) await writeCache(home, { 1: READING }, version);
        const [account] = await readClaudeSwapUsage({ home, nowMs: NOW });
        expect(account?.usageLimits).toMatchObject({
          windows: [],
          unavailable: { reason: "probeFailed" },
        });
      });
    },
  );

  it("does not expose arbitrary lastError text from a cache file", async () => {
    await withTempDir("claude-swap-usage-", async (home) => {
      await writeSlot(home, 1);
      await writeCache(home, {
        1: { ...READING, lastError: "error: unsafe diagnostic detail" },
      });
      const [account] = await readClaudeSwapUsage({ home, nowMs: NOW });
      expect(account?.usageLimits.serviceNotice).toEqual({
        message: "claude-swap's last usage update failed.",
        severity: "warning",
      });
    });
  });
});
