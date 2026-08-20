## UI evidence

**Validated:** The standalone observer renders its existing polling workflow through reusable Preact components without changing its read-only API or visible behavior.

- [x] Run list and detail render from the compiled binary
- [x] Timeline selection updates the pressed state and detail panel
- [x] Keyboard focus survives a polling update
- [x] Axe WCAG 2 A/AA: 0 violations
- [x] Browser console/page errors: 0

**Artifacts**

- Demo: `artifacts/pr-evidence/observer-preact/demo.webm`
- Screenshots: `artifacts/pr-evidence/observer-preact/screenshots/`
- Validation summary: `artifacts/pr-evidence/observer-preact/summary.md`
