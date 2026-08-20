# Envelopes

An envelope is an agent's final answer in a fixed shape. It carries a claim about what the agent found or did; it is not authority. Deterministic code must still decide whether work is safe to accept.

Free-form prose is hard to check. It can omit a field, use two names for one idea, or say `PASS` while listing a blocker. An envelope makes required information explicit and gives the runner something it can validate.

**Typed** means each role has named fields and allowed value types. The kernel uses TypeBox schemas and `parseEnvelope()` in `src/envelope.ts`.

## Two checks

1. **Structural validation** checks shape: required fields exist, arrays contain the right kinds of values, unknown fields are rejected, and reviewer verdicts use `PASS` or `FAIL`.
2. **Semantic validation** checks meaning inside that shape: non-empty strings are required; a ready planner needs changes and verification; `PASS` cannot have blocking findings; `FAIL` needs at least one blocking finding.

Passing both checks means only that the claim is well-formed. It does not prove a file was changed, a command passed, or a plan is wise.

## Submit flow

`runAgent()` can run in envelope mode for one role. It adds the `submit_envelope` tool, asks the agent to make that call last, captures its value, and runs structural and semantic validation again. A valid submission terminates the session. If missing or invalid, the runner records `envelope_invalid`, gives one correction prompt in the same session, and accepts or rejects the second result. No third attempt exists.

On acceptance, the run records `envelope_accepted` and writes `envelope.json`. Planner completion also renders `plan.md`. The receipt records role, validity, correction count, and envelope path. `events.jsonl` records lifecycle and envelope events; `sessions/` keeps the Pi transcript; `issue.md` keeps the input snapshot.

A setup or model failure produces a failed receipt and no completion artifacts. A cooperative deadline records `deadline_reached` and ends as `timed_out`; a hung SDK call can outlive this timeout. An invalid result after the one correction fails the run. These are runner outcomes, not proof that a proposed change is correct.

## Role shapes

Fields below are concise examples, not complete product decisions.

### Planner

Planner explains a possible change from repository evidence:

```json
{
  "summary": "Add envelope validation",
  "evidence": ["Runner accepts final agent text"],
  "changes": [{ "path": "src/envelope.ts", "action": "add", "rationale": "Check role output" }],
  "verification": ["bun run test"],
  "risks": ["Model may omit the tool"],
  "decisionsNeeded": []
}
```

### Worker

Worker reports implementation and checks actually run:

```json
{
  "implemented": "Added validation",
  "changedFiles": ["src/envelope.ts"],
  "validation": [{ "command": "bun run test", "outcome": "pass", "detail": "19 tests pass" }],
  "openRisks": []
}
```

### Reviewer

Reviewer gives an independent verdict:

```json
{
  "verdict": "PASS",
  "correct": ["Schema rejects unknown keys"],
  "blockingFindings": [],
  "nonBlockingFindings": [],
  "residualRisks": ["Timeout remains cooperative"]
}
```

All four schemas execute locally and through remote controller. Worker and documenter are sequential disjoint writers: worker owns approved non-doc paths; documenter owns approved docs paths. Docs-only runs skip worker. Verification and fresh read-only reviewer cover aggregate diff. Envelope shape never creates write, review, or acceptance authority.

## Still needed

Envelopes control output shape, not product truth. Controller independently requires repository-defined commands, exact Git diff/ownership checks, artifact safety, distinct linked role evidence, reviewed-patch binding, and reviewer `PASS`. GitHub publication and guaranteed cleanup while exe.dev deletion is unavailable remain future work. See [foundation checkpoint](foundation-checkpoint.md), [observer](observer.md), and [architecture](../ARCHITECTURE.md).
