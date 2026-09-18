# Emergency deploys

Log of every `Admin_Portal` deploy that bypassed `Quality_Gate` by invoking `npx wrangler deploy`
directly instead of going through `npm run build` (Workers Builds) or `npm run deploy`.

`Quality_Gate` has no bypass flag, no environment variable, and no branch condition. Skipping it is
therefore not a supported mode of operation — it is a manual act outside the tooling, and this file
is the record that makes it visible. Requirement 7.15 of the
`admin-quality-gates-and-shared-contracts` spec requires an entry here for each such deploy.

## Process

1. Deploy only if the situation genuinely cannot wait for a passing gate (production incident,
   `ops.snaptapp.us` down or serving a broken privileged path).
2. Add an entry below **in the same change set** that follows the deploy, using the template.
3. Run `npm run gate` locally and record every member that failed or was never reached. The gate
   short-circuits at the first failure, so members after the failing one are "not run" — list them,
   do not leave them implied.
4. **Return `main` to a passing `Quality_Gate` within 24 hours** of the entry's timestamp. That bound
   is the point of the record: a bypass buys hours, not a new baseline.
5. When the gate passes again, fill in the entry's *Remediated* line with the commit that restored it.
   An entry with an empty *Remediated* line older than 24 hours is an open violation.

`Quality_Gate` members, in execution order — name each one in the entry as `failing`, `not run`, or
`passing`:

`Lockfile_Check` → `Typecheck_Step` → `Lint_Step` → `Suppression_Check` → `Test_Suite`
(`Contract_Drift_Check` is not yet a member; `contract-adoption.json` is absent, so it is excluded.)

## Entry template

```markdown
### <UTC timestamp, e.g. 2026-01-14T09:12Z> — <short reason>

- **Commit deployed:** `<full 40-char sha>`
- **Operator:** <name / GitHub handle of the person who ran `npx wrangler deploy`>
- **Reason for bypass:** <what was broken, why it could not wait for a passing gate>
- **Gate members:**
  | Member | State |
  | --- | --- |
  | Lockfile_Check | passing / failing / not run |
  | Typecheck_Step | passing / failing / not run |
  | Lint_Step | passing / failing / not run |
  | Suppression_Check | passing / failing / not run |
  | Test_Suite | passing / failing / not run |
- **Failure detail:** <the diagnostic from each failing member, verbatim or summarized>
- **Remediation deadline:** <timestamp + 24 h>
- **Remediated:** <commit sha that returned `main` to a passing gate, and when — or `OPEN`>
```

## Entries

_None. No emergency deploy has been performed._
