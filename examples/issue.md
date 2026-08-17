# Add run status endpoint

## Context
Operators need a small health signal before workflow orchestration is added.

## Acceptance criteria
- Expose current process status through existing server conventions.
- Cover successful response with one automated check.
- Keep existing behavior unchanged.

## Scope
Application code and its existing tests.

## Non-goals
Authentication, persistence, dashboards, and deployment.
