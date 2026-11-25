# Fork Usage Dashboard Specification

## ADDED Requirements

### Requirement: Dual-View Usage Dashboard with Auto-Shown Quota Strip

The `/usage` modal SHALL present a dual top-level view (`Overview` as default and `Limits` for detailed quota pools), unify `Cost` and `Tokens` analytics inside `Overview` via a metric toggle while preserving existing usage keybindings, widen its inner content container to utilize the full modal width, and render a compact Quota Strip at the top of `Overview` whenever subscription limits are available.

#### Scenario: Open `/usage` with no persisted preference lands on Overview

- **WHEN** a user opens `/usage` for the first time without saved preferences
- **THEN** the modal SHALL open on the `Overview` view with the `Cost` metric active
- **AND** existing shortcuts (`usage.cost`, `usage.tokens`, `usage.limits`) SHALL switch to `Overview (Cost)`, `Overview (Tokens)`, and `Limits` respectively.

#### Scenario: Quota Strip auto-shows for subscription providers and auto-hides for API-only setups

- **WHEN** the active environment selection includes one or more providers or hubs reporting subscription limit windows and `showQuotaStrip` is enabled
- **THEN** `Overview` SHALL display a compact Quota Strip above the KPI cards showing each key window's remaining percentage with tiered risk styling (`>20%` normal, `<=20%` warning, `<=10%` critical) and reset countdown
- **AND** clicking any quota item SHALL switch directly to the `Limits` view
- **WHEN** no selected environment reports subscription limit windows (such as API-key-only or `omp`-only setups)
- **THEN** the Quota Strip SHALL render nothing without leaving an empty placeholder.

---

### Requirement: Natural Calendar Time Presets, Explicit Topbar Tools, and Persisted UI/Budget Options

The `/usage` topbar SHALL support `Today`, `24h`, `7 days`, `This month (MTD)`, `30 days`, and `90 days` windows, surface `Model prices`, `Export` (CSV/JSON), and a `🎛` display & soft-budget menu directly in the header, and persist Fork UI preferences under `localStorage["t3lab:usage-ui:v1"]`.

#### Scenario: Select calendar periods and compute aligned comparison windows

- **WHEN** the user selects `Today` or `This month (MTD)`
- **THEN** `Today` SHALL query from local midnight to the current time at hourly resolution (aligned against yesterday for comparison)
- **AND** `This month (MTD)` SHALL query from the 1st of the current local month to today at daily resolution (aligned against the matching elapsed span of the previous month for comparison).

#### Scenario: Surface Model prices and Export directly in topbar

- **WHEN** the user opens `/usage`
- **THEN** `Model prices` SHALL be directly accessible from the topbar without opening the environment filter menu
- **AND** clicking `Export` SHALL allow downloading the active filtered window summary and breakdown rows as either CSV or JSON.

#### Scenario: Persist display toggles and soft budget configuration safely

- **WHEN** the user modifies display toggles (`showQuotaStrip`, `showShareBars`, `showComparison`, `showBudget`), chart mode, or soft budget thresholds/scope in `🎛` and reloads
- **THEN** preferences SHALL persist under `localStorage["t3lab:usage-ui:v1"]`
- **AND** malformed JSON, missing keys, or storage access errors SHALL degrade cleanly per field to defaults without throwing.

---

### Requirement: Honest 4-Card KPI Strip, Period Comparison, and Scoped Soft Budget

The `Overview` view SHALL display a 4-card KPI strip surfacing total cost/tokens with period-over-period comparison and cost-source transparency, burn rate and effective rate, cache efficiency, and output with reasoning tokens, plus an optional non-blocking soft budget progress bar on matching periods.

#### Scenario: Honest period comparison and cost-source transparency

- **WHEN** `showComparison` is enabled and previous-period usage is available
- **THEN** the primary KPI card SHALL display the percentage delta versus the preceding aligned period when the baseline is positive, and SHALL render a neutral placeholder (never `Infinity%` or `NaN%`) when the baseline is zero
- **AND** in `Cost` mode, the card SHALL honestly distinguish provider-reported cost, model-priced estimate, and unpriced share, offering a direct `Set price` trigger whenever unpriced records exist.

#### Scenario: Display reasoning tokens and cache efficiency metrics

- **WHEN** usage records include cached input, cache writes, or reasoning tokens
- **THEN** the Cache Efficiency card SHALL display overall cache hit rate (`cachedInput / (uncachedInput + cachedInput + cacheCreation)`), cache savings amount, and savings multiplier when cost is positive
- **AND** the Output & Reasoning card SHALL display total output tokens alongside reasoning tokens and reasoning share (and speed premium when fast/ultrafast spend is positive).

#### Scenario: Soft budget bar applies only to matching periods and respects cost scope

- **WHEN** a daily budget is configured and the active window is `Today` (or a monthly budget is configured and the active window is `This month (MTD)`) and `showBudget` is enabled
- **THEN** the primary KPI card SHALL display a non-blocking budget progress bar colored by utilization (`<80%` normal, `80%..100%` warning, `>100%` critical)
- **AND** when `budgetScope` is set to `"reportedOnly"`, the bar SHALL measure strictly against `providerReportedCostUsd` rather than API-estimated subscription totals
- **AND** when viewing non-matching rolling windows (`24h`, `7 days`, `30 days`, `90 days`), the budget progress bar SHALL NOT extrapolate or mislead.

---

### Requirement: Interactive Stacked-Bar / Line Trend Chart, Provider Quick-Filter, and Semantic Share Bars

The `Overview` analytics section SHALL provide a ranked provider list supporting one-click provider filtering, an interactive trend chart defaulting to stacked bars with a line comparison toggle and click-to-lock bucket inspection, and semantic theme-token structure share bars.

#### Scenario: Click provider row to solo-filter and clear via active filter chip

- **WHEN** the user clicks a provider in the ranked provider list
- **THEN** the dashboard SHALL filter all overview KPIs, trend series, share bars, and breakdowns to that provider and display an active filter chip in the filter bar
- **AND** clicking the same provider again or dismissing the chip SHALL restore the prior provider selection.

#### Scenario: Toggle stacked bar vs line chart and lock a time bucket

- **WHEN** the user views the trend chart
- **THEN** it SHALL default to a stacked bar chart where each bar's total height reflects the exact period total across active providers, with a toggle to switch to multi-provider line comparison
- **AND** clicking a day or hour bar SHALL lock/highlight that bucket and highlight matching rows in the `Time` breakdown (clicking again clears the lock).

#### Scenario: Semantic color tokens for structure share bars

- **WHEN** token or cost structure share bars render in light or dark mode
- **THEN** `Input`, `Cache read`, `Cache write`, `Output`, and `Reasoning` segments SHALL use distinct semantic CSS tokens declared in `apps/web/src/index.css` passing `shadcn/no-raw-colors`.

---

### Requirement: Backward-Compatible Server Attribution for Projects and Top 50 Sessions

The server usage pipeline SHALL extract working directories and session titles from real provider transcripts and databases, normalize and merge git worktrees into canonical projects, match sessions to T3 threads where available, return optional `projects` and bounded `topSessions` (max 50) on `UsageSummary`, and support optional `projectFilter` on `UsageSummaryInput` without breaking older clients or servers.

#### Scenario: Extract `cwd` and session titles across real provider formats

- **WHEN** `UsageService` scans transcripts or databases for `omp`, `Pi`, `Claude Code`, `Codex`, and `OpenCode`
- **THEN** it SHALL extract `cwd` (`session.cwd`, `record.cwd`, `payload.cwd`, or `session.directory`) and available native titles (`omp` line-0 `title`, `Pi` `session_info`, `Claude` `ai-title`/`custom-title`, `OpenCode` `session.title`)
- **AND** providers or legacy records lacking `cwd` and unmatched by T3 metadata SHALL be attributed honestly to `"__unattributed__"` without fabricating project paths.

#### Scenario: Merge worktrees into canonical projects and link T3 threads

- **WHEN** sessions execute across a repository root and one or more linked git worktrees
- **THEN** project aggregation SHALL merge them under the canonical project key (preferring matching T3 `ProjectStore` entries, with bounded timeout-safe git common-dir fallback that never hangs on macOS protected folders) and record the merged worktree count
- **AND** sessions matching a T3 thread via `nativeThreadRef.nativeId` (handling both UUID native IDs for Claude/Codex/OpenCode/Grok and session file paths ending in `_<sessionId>.jsonl` for `omp`/`Pi`) SHALL expose `t3ThreadId`, `t3ProjectId`, and the live T3 thread title.

#### Scenario: Cross-filter full summary by project and bound wire payload

- **WHEN** `UsageSummaryInput` includes `projectFilter`
- **THEN** `UsageService` SHALL filter aggregated buckets, totals, and top sessions to records resolving to that canonical project key using the warm scan cache
- **AND** `UsageSummary.topSessions` SHALL be capped at 50 entries per environment and all new contract fields SHALL remain optional so servers and clients implementing `USAGE_MERGE_COMPATIBLE_SINCE` interoperate without version mismatch errors.

---

### Requirement: 4-Tab Breakdown Table with Sorting, Search, Thread Navigation, and Tokens-Mode Time Fix

The `Overview` breakdown section SHALL offer four views (`Model`, `Project`, `Top Sessions`, `Day/Hour`), support sorting and filtering, enable project cross-filtering and T3 thread jump navigation, and fix the upstream `Day/Hour` table bug under `Tokens` mode.

#### Scenario: Sortable and searchable Model breakdown with inline pricing action

- **WHEN** the user views the `Model` breakdown tab
- **THEN** the table SHALL display `#`, `Model`, `Cost`, `Share`, `Tokens`, `Cache Hit %`, and `$/1M` with sortable column headers and keyword search
- **AND** unpriced models SHALL expose an inline `Set price` button opening the price overrides dialog pre-targeted to that model
- **AND** clicking a model row SHALL open the model detail dialog including reasoning tokens and project distribution.

#### Scenario: Project click cross-filters Overview and Top Sessions click navigates to T3 thread

- **WHEN** the user clicks a row in the `Project` breakdown tab
- **THEN** the dashboard SHALL activate that project as a top-level filter pill and recompute the Overview KPIs, trend chart, and breakdowns scoped to that project
- **WHEN** the user clicks a row in the `Top Sessions` tab that has a linked `t3ThreadId` on a connected environment
- **THEN** the `/usage` modal SHALL close and navigate directly to that T3 thread
- **WHEN** the user clicks an external CLI session with no linked T3 thread
- **THEN** it SHALL open a read-only session detail dialog displaying provider, project path, model, token/cost breakdown, and copyable session ID.

#### Scenario: Day/Hour breakdown honors Tokens metric mode

- **WHEN** the active metric is `Tokens` and the user views the `Day/Hour` breakdown tab
- **THEN** every provider column and the `Total` column SHALL format token counts (`formatTokens`) while displaying `Cost` in the secondary column
- **AND** when the active metric is `Cost`, provider columns and `Total` SHALL format currency (`formatUsd`) with `Tokens` in the secondary column.

#### Scenario: Graceful degradation when connected to an older remote environment

- **WHEN** a selected remote environment returns a `UsageSummary` without `projects` or `topSessions`
- **THEN** the `Project` and `Top Sessions` tabs SHALL display an honest informational notice explaining that the environment's server does not report project/session breakdown yet, without crashing or fabricating zeroed rows.

---

### Requirement: Risk-Tiered Limits View with Direct Reset Details and Minute Countdown

The `Limits` view SHALL align visually with the Fork HUD Quota card by applying semantic risk tiers, surfacing plan names, exact reset timestamps, and a low-overhead minute-ticking countdown directly on cards, and providing a quick link to manage usage limit hubs in Settings.

#### Scenario: Direct visibility of risk tier, plan, exact reset timestamp, and pace

- **WHEN** the user opens the `Limits` view with active subscription limit pools
- **THEN** each pool card SHALL color remaining capacity by semantic risk tier (`>20%` normal, `<=20%` warning, `<=10%` critical), display the account plan, exact reset timestamp, pace indicator, and countdown directly without requiring hover
- **AND** countdown updates SHALL run on an isolated minute-interval leaf only while the `Limits` view or Quota Strip is mounted, avoiding high-frequency animations or full-page repaints
- **AND** the `Limits` header SHALL include a quick link navigating to `/settings/providers#usage-providers` to manage CLI Proxy hubs while preserving multi-account pool segments and reset-credit redemption.

---

### Requirement: Full Localization and Anti-Regression Compliance

All new user-facing strings across the Fork usage dashboard SHALL be localized across all 10 web translation catalogs and comply with Fork lint, export, and isolation invariants.

#### Scenario: Localization and static guard verification

- **WHEN** the usage dashboard changes are verified
- **THEN** every new user-facing string SHALL use `gt-react` and be translated across all 10 catalogs in `apps/web/src/i18n/translations/*.json` passing `vp run i18n:check`
- **AND** no native HTML `title` attributes, raw Tailwind palette colors, or unused production exports SHALL be introduced (`vp run check:changed origin/lmx-lab` green).
