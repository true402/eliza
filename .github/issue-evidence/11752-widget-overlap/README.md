# #11752 — Home widget grid: first-row widgets overlap (icon/text collision) on mobile

## Root cause

`WidgetHost` renders the home slot as a fixed 4-column grid (`grid-cols-4`,
`minmax(0,1fr)` tracks ≈ 85px at a 402px mobile viewport) and passes each
widget its `spanClassName` (default `col-span-2 row-span-1`). The contract
(`WidgetProps.spanClassName` docs) says **the widget applies this to its single
root grid-item element** — but eight home widgets never did:

- `finances-alerts`, `goals-attention`, `health-sleep`, `inbox-unread`,
  `needs-attention` (`_props`, `HomeWidgetCard` button rendered directly as the
  grid item)
- `notifications` (home branch), `agent-orchestrator` activity + app-runs,
  `todo` (home branch) — `ChatSidebarWidgetProps` didn't even carry
  `spanClassName`

Their root became a span-1 auto-placed 85px cell; the card's non-shrinkable
flex chrome (32px icon chip + paddings + badge) overflowed the cell
(measured: finances 169px content in an 85px cell, health 152px, orchestrator
activity 127px) and painted over the neighboring card — the reported
"Overdr[icon]wn" collision.

## Fix

Each offending widget now wraps its card in the established
`<div className={"min-w-0 " + spanClassName}>` root (same pattern as
`relationships-attention`, locked by its existing tests), with the
`col-span-2 row-span-1` default. `ChatSidebarWidgetProps` gains the
`spanClassName` passthrough. Dual-slot widgets (todo, app-runs) wrap only on
`home`, leaving the chat-sidebar DOM untouched.

## Regression gate

`run-home-screen-e2e.mjs` now measures the real boxes on the mobile home:
every grid item's painted content (union of descendant client rects) must fit
its own cell (`scrollWidth <= clientWidth + 1px`) and no two items' content
boxes may intersect.

The same e2e also keeps the rail-swipe frame gate. The dropped-frame ratio uses
a 0.5ms timestamp epsilon so headless Chromium's 16.7-16.8ms 60 Hz rAF
quantization does not count as dropped frames; p95 and frames beyond that
epsilon still gate real swipe jank.

Full app visual audit was run after rebasing onto current `develop`:
`bun run --cwd packages/app audit:app` passed 349/349 with 0 broken, 0
needs-work, 0 minimalism/probe failures. Manually reviewed the regenerated
mobile home screenshot and the app `/apps` mobile audit capture; no
icon/text collisions or incoherent overlaps were visible.

## Files

- `before-mobile-home.png` — develop code, mobile 402px: finances/goals and
  health/activity cards painted on top of each other.
- `after-mobile-home.png` — fixed grid: two 2-col cards per row, no collisions.
- `fail-without-fix-e2e.log` — the new geometry gate against the OLD widget
  sources: exit 1, `HOME-SCREEN E2E FAILED (7)` — 5 content-overflow reds
  (84px / 67px / 42px / 4px / 4px) + 2 literal pair overlaps
  (finances×goals x74/y52, health×activity x57/y52).
- `pass-with-fix-e2e.log` — full suite green with the fix (exit 0).

Repro: `bun run --cwd packages/ui test:home-screen-e2e` → inspect
`src/components/shell/__e2e__/output-home/01-mobile-home.png`.
