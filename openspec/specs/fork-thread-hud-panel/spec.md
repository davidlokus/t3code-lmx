# fork-thread-hud-panel Specification

## Purpose

TBD - created by archiving change thread-hud-panel. Update Purpose after archive.

## Requirements

### Requirement: Thread HUD Header and Persisted Display Options

The right-side thread details panel SHALL render a compact HUD status header showing the active thread status badge, resolved provider and model label, and a HUD options popover trigger (`🎛`) backed by browser-persisted display preferences.

#### Scenario: Display live thread status and model delta in HUD header

- **WHEN** the thread details panel is open for a thread whose runtime status is active, pending approval, pending user input, waiting, errored, or idle
- **THEN** the HUD header SHALL render the matching semantic status badge and provider/model identity
- **AND** when the provider reports a served model that differs from the requested model, the header SHALL reflect the actual served model and indicate the model change.

#### Scenario: Toggle HUD card visibility and persist across reloads

- **WHEN** the user opens the HUD options popover (`🎛`), disables one or more HUD cards (Context, Session, Quota, Activity, System), and reloads the application
- **THEN** preferences SHALL be persisted under `localStorage["t3lab:hud-ui:v1"]`
- **AND** disabled cards SHALL remain hidden after reload
- **AND** clicking Reset defaults SHALL restore all five cards to visible and the System card to collapsed.

#### Scenario: Corrupt or unavailable storage degrades safely to defaults

- **WHEN** `localStorage["t3lab:hud-ui:v1"]` contains malformed JSON, non-object data, or throws on access
- **THEN** the HUD options store SHALL fall back to default options (`showContext: true`, `showSession: true`, `showQuota: true`, `showActivity: true`, `showSystem: true`, `systemExpanded: false`) without throwing.

---

### Requirement: Non-Destructive Integration with Thread Details Layout

The HUD sections SHALL integrate into `ThreadDetailsPanel` without breaking existing Workspace, Version Control, Pull Request, or density layout behaviors.

#### Scenario: HUD sections do not force ThreadDetailsCard into essential density

- **WHEN** `ThreadDetailsPanel` renders in a constrained viewport height (such as 280x400) with HUD sections mounted
- **THEN** `[data-thread-hud-panel]` containers SHALL be excluded from `ThreadDetailsCard`'s density-collapse height calculation
- **AND** Workspace, linked Pull Requests, and `Initialize Git` controls SHALL remain visible as required by existing panel behavior.

#### Scenario: Legacy Usage and Context sections are deduplicated without creating a one-way door

- **WHEN** the HUD Context or Quota card is enabled and rendered
- **THEN** `ThreadDetailsPanel` SHALL suppress the duplicate legacy `ThreadDetailsContext` or `ThreadDetailsUsage` section for that capability
- **AND** when the user disables the corresponding HUD card in `🎛`, the legacy upstream item toggle SHALL remain operable.

---

### Requirement: Context Lens Card with 4-Bucket Estimate, Isolated Cache Hit Rate, Warm/Cold Countdown, and In-Place Compact

The HUD Context card SHALL surface real context window utilization, a clearly labeled approximate 4-bucket breakdown, single-model prompt cache hit rate, an isolated self-ticking prompt cache countdown, non-zero per-turn token breakdown, and an in-place `/compact` trigger.

#### Scenario: Tiered utilization tone and 200k+ warning badge

- **WHEN** context usage is available for the active thread
- **THEN** the card SHALL display the used percentage and token ratio using semantic tones (`normal` below 65%, `warning` from 65% to below 85%, `error` at or above 85%)
- **AND** when `usedTokens >= 200000`, the card SHALL render a `!200k+` warning badge
- **AND** when `autoCompactThreshold` lies strictly between `0` and `maxTokens`, the stacked progress bar SHALL display a threshold tick marker.

#### Scenario: Approximate 4-bucket breakdown after latest compaction

- **WHEN** context usage is positive
- **THEN** the Context metrics derivation SHALL partition `usedTokens` across four non-negative integer buckets (`systemBase`, `tools`, `assistant`, `user`) summing exactly to `usedTokens`, scoped to the active provider thread and items occurring after the latest completed `compaction` item
- **AND** the UI SHALL clearly mark bucket values as approximate (`≈`)
- **AND** the first bucket label SHALL switch from `System base` to `Compaction base` when a completed compaction item exists on the active provider thread.

#### Scenario: Single-model prompt cache hit rate isolation

- **WHEN** a thread switches models mid-conversation across multiple provider turns
- **THEN** `lastTurnCacheHitRate` and `cumulativeCacheHitRate` SHALL be computed strictly from delivered turns on the active provider thread matching the current active model
- **AND** turns from other models or multi-model turns SHALL NOT pollute the reported hit rate.

#### Scenario: Isolated prompt cache warm/cold countdown

- **WHEN** the active turn provides a prompt cache expiration timestamp (or TTL / positive cached input timestamp)
- **THEN** a dedicated leaf countdown component SHALL subscribe to `secondTick` ONLY while `expiresAtMs > nowMs` (`warm` state)
- **AND** once `expiresAtMs <= nowMs` (`cold` state), the leaf component SHALL unsubscribe from `secondTick` and render the static cold state without triggering parent card re-renders.

#### Scenario: In-place compact action reuses upstream path

- **WHEN** the user clicks the compact action button in the Context card while compaction is enabled
- **THEN** it SHALL invoke the existing `onCompactContext` handler from `ChatView` without introducing new RPC endpoints
- **AND** when compaction is disabled, the button SHALL be disabled and explain why via a `<Tooltip>` (never a native `title` attribute).

---

### Requirement: Honest Session KPIs Card (Zero Fabrication)

The HUD Session card SHALL display a compact 2x2 KPI grid derived strictly from real observed turn and thread data, rendering `—` whenever a metric is genuinely unavailable.

#### Scenario: Throughput and TTFT never fabricate zero values

- **WHEN** no completed turn with positive output tokens and valid elapsed duration (`>= 100ms`) exists
- **THEN** `tokensPerSecond` SHALL be `null` and the UI SHALL display `—` (never `0 tok/s`)
- **AND** `ttftMs` SHALL be `null` (rendered as `—`) whenever the contract provides no real first-token timestamp.

#### Scenario: Cost and subscription attribution remain honest

- **WHEN** `contextWindow.cost` contains a real finite amount and currency
- **THEN** the card SHALL display the formatted monetary cost
- **WHEN** `contextWindow.cost` is absent and the active provider has usage quota windows
- **THEN** the card SHALL label billing as subscription-based rather than fabricating `$0.00`
- **WHEN** neither real cost nor quota windows exist
- **THEN** the card SHALL display `—`.

#### Scenario: Active duration, wall-clock span, and model/mode metadata

- **WHEN** runs or turns exist on the thread
- **THEN** the card SHALL display active execution duration, wall-clock span, turn count, actual served model (showing `requested → served` when they differ), and thinking effort / mode metadata when present.

---

### Requirement: Quota Limits Card with Directly Visible Reset Countdowns

The HUD Quota card SHALL reuse upstream read-only limit resolution (`resolveThreadDetailsLimits`) with zero additional network polling, display reset countdowns directly in each row, and auto-hide when no limits apply.

#### Scenario: Render all active quota windows with visible reset countdowns

- **WHEN** `resolveThreadDetailsLimits` returns an instance or pool limit set with windows
- **THEN** the Quota card SHALL render every window with its label, remaining percentage (color-tiered at `<=20%` warning and `<=10%` error), progress bar with pace tick, and directly visible reset countdown text without requiring hover
- **AND** clicking a window row SHALL navigate to `/usage`.

#### Scenario: Auto-hide when provider has no limits

- **WHEN** `resolveThreadDetailsLimits` returns `null` (for example on API-key or Replay providers)
- **THEN** the Quota card SHALL render nothing.

---

### Requirement: Activity Card for Subagents and Top Tools

The HUD Activity card SHALL summarize subagents and top tool invocations from `ThreadStructure` and auto-hide when neither is present.

#### Scenario: Subagent click navigation and status display

- **WHEN** the thread projection contains subagents
- **THEN** the Activity card SHALL list active and recent subagents (active first, capped to 8 with overflow count) with status, display title, model, and elapsed duration
- **AND** clicking a subagent row that has a `childThreadId` or `remoteChild` SHALL navigate to or open that linked thread.

#### Scenario: Top tool pills with running and failure badges

- **WHEN** the thread projection contains tool turn items (`command_execution`, `file_change`, `file_search`, `web_search`, `dynamic_tool`)
- **THEN** the Activity card SHALL aggregate them by normalized tool name (capped to top 8), prioritizing running tools then descending call count
- **AND** tools with any failed execution (`status === "failed"`, non-zero `exitCode`, or `outputIndicatesFailure === true`) SHALL display a failure count badge and semantic error/warning styling.

#### Scenario: Auto-hide when thread has no subagents and no tool items

- **WHEN** the thread projection has zero subagents and zero tool turn items
- **THEN** the Activity card SHALL render nothing.

---

### Requirement: Visibility-Gated Collapsible System Card

The HUD System card SHALL start collapsed by default, display real T3 process telemetry without fabricating host RAM totals, and strictly gate telemetry subscriptions on panel visibility and card enablement.

#### Scenario: Visibility-gated resource telemetry subscription

- **WHEN** the right-side thread details panel is closed OR the user disables `showSystem` in `🎛`
- **THEN** the component calling `useResourceTelemetry(environmentId)` SHALL NOT mount (or SHALL pass `null`) so telemetry streaming is immediately unsubscribed
- **WHEN** the panel is open AND `showSystem` is enabled
- **THEN** the System card SHALL render a 1-line summary bar (real T3 CPU %, real T3 RSS memory, process count) while collapsed by default.

#### Scenario: Expanded System details show process breakdown, local ports, and total processed tokens

- **WHEN** the user expands the System card
- **THEN** it SHALL display non-empty process categories (`Provider`, `Terminal`, `Server`, `Desktop`, `Other`) with count, CPU %, and RSS bytes
- **AND** it SHALL display clickable local detected ports for the thread via `useThreadDiscoveredPorts` (when any exist)
- **AND** it SHALL display cumulative `Σ totalProcessedTokens` when real token data is available, without fabricating host total memory.

---

### Requirement: Streaming Render Isolation and Full Localization

The HUD SHALL avoid streaming re-render thrash, respect design-system token rules, and localize all user-facing strings across all 10 supported locales.

#### Scenario: Zero streaming token re-render thrash

- **WHEN** an assistant reply or reasoning stream emits incremental text chunks
- **THEN** HUD components SHALL read `useQuietThreadProjection(threadRef)` (`ThreadStructure`) rather than `useThreadProjection` so streaming text deltas do not re-render HUD cards.

#### Scenario: Semantic design tokens and 10-locale translations

- **WHEN** HUD components render in light or dark mode and any supported locale
- **THEN** all colors SHALL use declared semantic theme tokens in `apps/web/src/index.css` (passing `shadcn/no-raw-colors`)
- **AND** all new user-facing copy SHALL be wrapped with `gt-react` and present across all 10 catalogs in `apps/web/src/i18n/translations/*.json` passing `vp run i18n:check`.
