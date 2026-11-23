# fork-sidebar-navigation Specification

## Purpose

Defines T3 Lab (Extend)'s Fork-owned left sidebar navigation model, including brand identity, cross-host project disambiguation, aligned status lane, compact metadata slots, deleted-provider icon fallback, and local display options.

## Requirements

### Requirement: Fork brand wordmark in sidebar header

The sidebar header brand mark MUST render the T3 Lab brand suffix derived from `forkIdentity` instead of a hardcoded upstream `"Code"` suffix while preserving home navigation and accessibility labeling.

#### Scenario: Sidebar header renders T3 Lab wordmark

- **WHEN** the sidebar chrome header mounts on desktop or web
- **THEN** the brand mark displays `T3` followed by `Lab` (derived from `forkIdentity.baseName`) and links to `/` with an accessible T3 Lab home label

### Requirement: Single-host quietness and multi-host project disambiguation

The sidebar MUST hide redundant environment labels in single-environment setups and disambiguate project headers and rows only when multiple environments are present.

#### Scenario: Single environment hides all device labels

- **WHEN** only one environment is connected and all project groups belong to that single environment
- **THEN** project folder headers display no host label and thread rows display no environment label

#### Scenario: Multi-environment colliding project names label every colliding header

- **WHEN** two or more connected environments contain project groups sharing the same normalized display name
- **THEN** every colliding project folder header displays a compact host label with its machine icon, while individual thread rows inside a single-host folder omit redundant environment labels

#### Scenario: Remote-only project header labels its remote host once

- **WHEN** multiple environments are active and a project group exists only on a non-primary remote environment
- **THEN** the project folder header displays the remote host label and thread rows inside that folder do not repeat it

#### Scenario: Non-primary rows in status view or mixed cross-host folder retain light host context

- **WHEN** a thread row renders in status view or inside a mixed-environment folder and belongs to a non-primary environment
- **THEN** the row shows its compact environment label, whereas primary-environment rows omit it

### Requirement: Fixed status lane priority and dim-when-read contrast

Each sidebar thread row MUST render a fixed-width left status lane following strict priority ordering and MUST dim quiet read thread titles when `dimWhenRead` is enabled.

#### Scenario: Status lane resolves strict priority

- **WHEN** a thread has concurrent status signals such as approval, input, request, working, failed, woke, unread completion, or unsent draft
- **THEN** upstream row status resolves runtime/request priority (`approval` > `input` > `request` > `working` > `failed`/`limited` > quiet) and the status lane layers row-level signals underneath (`woke` > `unread-done` > `draft` > `none`)

#### Scenario: Quiet read thread title dims while active or urgent threads stay emphasized

- **WHEN** `dimWhenRead` is enabled
- **THEN** an inactive, unselected, already-read `ready` or `waiting` thread renders with dimmed title styling, while active, selected, unread, working, approval, input, request, woke, or failed threads keep emphasized title contrast

#### Scenario: Disabling dim-when-read restores full title contrast

- **WHEN** the user turns off `dimWhenRead` in the sidebar options menu
- **THEN** quiet read thread titles render without dimming

### Requirement: Right-side signal tiering and adaptive metadata row

Each sidebar thread row MUST distinguish urgent states from quiet timestamps on the right edge and render a second metadata row only when enabled metadata is present and compact single-line mode is off.

#### Scenario: Urgent statuses render loud pills while quiet rows align fixed-width timestamps

- **WHEN** a thread status is `approval`, `input`, `request`, `failed`, or `limited`
- **THEN** the right slot renders a compact colored pill, whereas `working`/`preparing` renders a tabular live duration and quiet rows render a right-aligned fixed-width relative timestamp that swaps to hover actions

#### Scenario: Second metadata row displays branch, worktree, non-default modes, and compact model name

- **WHEN** compact single-line mode is off and a thread has a Git branch or worktree, non-default mode (`plan` or `full-access`), or a non-sentinel model name
- **THEN** the left half shows branch or worktree (turning amber on branch mismatch), non-default `Plan`/`Full` badges, and existing PR/Issue/terminal badges, while the right half shows handoff history icons, the current provider icon, and the compact monospace model name

#### Scenario: Empty metadata or compact single-line mode collapses cleanly to one line

- **WHEN** compact single-line mode is enabled OR no left-side metadata is visible and model labels are hidden
- **THEN** the row omits the second metadata row and promotes the provider icon stack onto the title line

### Requirement: Deleted provider instance icon fallback

The sidebar MUST render a deterministic provider icon or neutral monogram fallback when a historical thread references a removed custom provider instance.

#### Scenario: Deleted custom omp instance falls back to omp icon

- **WHEN** a thread references a removed provider instance ID such as `omp_omp_3` whose entry is absent from `providerEntryByInstanceId`
- **THEN** the sidebar infers the `omp` driver kind from `runtime.providerName` or instance ID prefix and renders the `omp` icon instead of blank space

#### Scenario: Unrecognized deleted provider instance renders neutral initials badge

- **WHEN** a thread references a removed provider instance ID that matches no known driver kind
- **THEN** the sidebar renders a neutral compact monogram fallback derived from the display name or instance ID

### Requirement: Minimal header controls and local sidebar UI preferences

The sidebar MUST expose collapse/expand all, an attention-only bell filter, and a display options popover persisted locally under `t3lab:sidebar-ui:v1` without modifying wire contracts.

#### Scenario: Attention bell filter isolates urgent and unread threads with one-click reset

- **WHEN** the user activates the attention filter button
- **THEN** the sidebar shows only threads matching working, approval, input, request, failed, limited, unread, or woke states and provides a one-click control to restore all threads

#### Scenario: Display options persist across reloads and tolerate corrupted storage

- **WHEN** the user toggles grouping, compact single-line, dim-when-read, branch, model, or mode badge options
- **THEN** preferences persist to `localStorage` under `t3lab:sidebar-ui:v1` and corrupted or partial JSON falls back cleanly per field to defaults
