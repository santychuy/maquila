## Context

The fixture repository exposes a small `greet(name)` function. It currently returns a calm greeting only. This scenario must exercise implementation, tests, documentation, deterministic verification, and independent review.

## Acceptance criteria

- Add an optional excited mode while preserving the existing default greeting.
- `greet("Ada")` returns `Hello, Ada.`.
- `greet("Ada", true)` returns `Hello, Ada!`.
- Cover both modes with automated tests.
- Update `docs/greeting.md` with both examples.
- Keep blank-name validation unchanged.

## Scope

`src/greeting.ts`, `test/greeting.test.ts`, and `docs/greeting.md`.

## Non-goals

CLI changes, dependencies, localization, persistence, or publication.
