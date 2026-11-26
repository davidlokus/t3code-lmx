# Proposal: Usage Limits UI Redesign (`usage-limits-ui-redesign`)

## Why

The current Subscription Quota Intelligence views (`Matrix` and `Pool`) suffer from five compounding visual defects when managing many accounts (13+ accounts / 29+ windows):

1. **Full-width slabs with massive dead whitespace**: `UsageLimitsMatrixView` stacks 100%-width banners vertically with an internal 3-column sub-grid, leaving 33%–66% empty void on 1- and 2-window accounts; `UsageLimitsPooled` renders oversized 32px translucent green bars per window and dumps HTTP/external quota accounts as unstyled plain-text rows at the bottom.
2. **Box-in-box nesting**: Page frame -> account border -> inner window border -> pill badge -> progress bar -> pace badge creates visual noise.
3. **Neon green overload hiding signal**: Healthy 98%–100% windows render in high-saturation `bg-success` green, drowning out fast-burn (`will-exhaust`) and low-quota warnings.
4. **Duplicate metadata noise**: Source badges (`OMP cache`) repeat right next to identical subtitle text (`OMP Local Cache`); `window.scopeLabel` repeats `account.plan` on every window (`Muse Code Power Usage` shown 3 times); `Track renewal` floats isolated in the far top-right corner.
5. **Cluttered control bar & middle dots**: A heavy bordered card wraps 4 lens tabs plus 3 competing segmented controls and `·` middle-dot separators.

## What Changes

- **Restrained Visual System (`usageLimitsPresentation.ts`)**:
  - Neutral architectural bars (`bg-foreground/40` on `bg-muted/80`, 3px–4px `h-1`) and crisp `text-foreground` percentages for healthy accounts; reserve semantic `warning` (amber) and `error` (red) strictly for low-quota, fast-burn (`will-exhaust` / `ahead`), exhausted, or failed states.
  - Pure deduplication helpers removing duplicate source/where labels (`OMP cache` + `OMP Local Cache`) and redundant window `scopeLabel` matching account `plan`/`label`, plus risk-first account sorting and unified platform pool grouping across ALL providers and external quota sources.
  - Eliminate `·` middle-dot separators across all redesigned quota views.
- **Borderless Editorial Header (`UsageLimitsEnhanced.tsx`)**:
  - Replace the heavy boxed two-row control card with a lightweight header (title, inline tabular counters, clickable alert jump pill, subtle `Manage limit hubs` link) and a clean bottom-bordered underline tab bar (`Pools`, `Resets`, `Alerts`, `Expiries`) with right-aligned `Cards` / `Table` view toggle + compact display-format switches (`Left/Used`, `Countdown/Exact`) and optional `At risk` focus filter when risks exist.
- **View 1 — Multi-Column Bento Card Wall (`UsageLimitsMatrixView.tsx`, default `limitsLayout: "matrix"`)**:
  - Responsive 1 / 2 / 3-column card grid (`md:grid-cols-2 xl:grid-cols-3`) fitting 6–9 accounts per screen with zero wasted right-hand void.
  - Flat borderless hairline window rows (`divide-y`) inside each account card — zero nested window sub-cards — with subtle top/border tint only for at-risk accounts, compact icon-only renewal action button in card header, crisp 3px pace-marked bars, inline balances footer, and deduplicated headers.
- **View 2 — Expandable Platform Summary Table (`UsageLimitsPoolTableView.tsx`, replaces `Pool` view)**:
  - Unified platform-grouped compact summary table covering BOTH native/CLI/OMP providers AND HTTP/OpenRouter/Copilot/Ollama/OpenAI API quota sources under one cohesive layout (no plain-text tail).
  - Each platform renders a crisp summary row (provider icon, name, account count badge, deduplicated plan, inline window progress bars with aggregate `%` & fast-burn icon, soonest reset/refill time, expand toggle); expanding reveals per-account rows with redacted email, individual bars, burn pace, balances, renewal tracking, and inline reset-credit redemption (`useResetCredit` + `ResetCreditDialog`), plus external usage links & limit notices cleanly integrated below.
- **Unified Restrained Language Across Sibling Views**:
  - Refine `UsageQuotaStrip.tsx`, `UsageLimitsResetsView.tsx`, `UsageLimitsAlertsView.tsx`, and `UsageLimitsExpiriesView.tsx` to share the exact restrained color palette, 3px–4px tracks, tightened typography, deduplicated metadata, and zero middle-dot separators.
- **Full 10-Locale i18n & Tests**:
  - Update unit tests (`usageLimitsPresentation.test.ts`, `usageDashboard.logic.test.ts`), Chromium browser tests (`usageLimitsIntelligence.browser.test.tsx`, `usageDashboard.browser.test.tsx`), React Compiler coverage, and all 10 locale translation files.

## Out of Scope

- No backend / server / contracts / SQLite changes.
- No modifications to upstream `apps/web/src/components/usage/UsageLimits*.tsx` unless required for `knip` export hygiene.
- No changes to canonical account identity or manual subscription override persistence keys.
