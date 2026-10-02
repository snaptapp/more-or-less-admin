# HANDOFF: Finish OPS_ASSISTANT_SECRET + Notion Ops Assistant wiring

**Owner:** local coding agent on Tony's machine  
**User:** Tony Thompson  
**Goal:** Make **More-or-Less Ops Assistant** successfully call live Fact Bank tools end-to-end. Stop the loop of re-setting secrets until a verified smoke test passes.

Do **not** ask Tony to re-enter the secret repeatedly. Generate **one** strong secret once, set it in both places, verify, then stop.

---

## Context

PR [#10](https://github.com/snaptapp/more-or-less-admin/pull/10) merged into `snaptapp/more-or-less-admin`. It added:

- Admin read-only Ops API: `GET https://ops.snaptapp.us/api/internal/ops/factbank/{health|distribution|validation|duplicates|drift|inspect|snapshot}`
- Auth: Bearer `OPS_ASSISTANT_SECRET` (required in prod; do **not** reuse `OPS_CRON_SECRET`)
- Notion Workers under `notion-workers/` that call that API

Repo checkout (adjust if different):

```text
<path>/more-or-less-admin/
  wrangler.jsonc                    # Worker name: tanstack-start-app → ops.snaptapp.us
  .env.example                      # documents OPS_ASSISTANT_SECRET
  notion-workers/
    README.md                       # deploy / env docs
    AGENT_INSTRUCTIONS.md           # paste into Notion agent
    more-or-less-factbank/          # Fact Bank tools Worker
    cloudflare-state-inspector/     # CF health tools (optional second)
```

Notion Custom Agent:

- Name: **More-or-Less Ops Assistant**
- Workspace (pick this one when `ntn` prompts): **Trackdub `01454199-cd94-8168-873e-00038ccb0750`**
- Ignore the other Trackdub workspace `a676662b-decf-40aa-9f1f-befb3d62a4f4`
- Agent id path: `agent://01454199-cd94-8168-873e-00038ccb0750/19fa648d-a69d-4ada-b311-5e3bc09dd764`
- Fact Bank worker already deployed once: https://app.notion.com/developers/workers/01a0fb75-8c71-77fc-b769-0d2f008a8bd9

---

## Auth model (read before changing anything)

| Place | Env var | Role |
| --- | --- | --- |
| Cloudflare Worker `tanstack-start-app` (ops.snaptapp.us) | `OPS_ASSISTANT_SECRET` | Server gate for `/api/internal/ops/*` |
| Notion worker `more-or-less-factbank` | `OPS_ASSISTANT_SECRET` | Same value; sent as `Authorization: Bearer …` |
| Notion worker | `OPS_API_BASE_URL` | `https://ops.snaptapp.us` |

Rules:

1. **Same secret string** on Admin Worker and Notion worker.
2. **Never** use `OPS_CRON_SECRET` as a stand-in in production.
3. Do **not** set `OPS_ASSISTANT_ALLOW_CRON_FALLBACK` in production.
4. `workers.json` is gitignored and created by `ntn workers deploy`. If missing, **deploy before** `env set`.

---

## Step 1 — One secret

```sh
# generate once; keep it in memory / password manager, not in git
openssl rand -base64 32
```

Call this value `SECRET` below. Do not commit it. Do not put it in chat logs if avoidable.

---

## Step 2 — Admin Worker (Cloudflare)

From `more-or-less-admin` root (must be Wrangler-authenticated to the account that owns `tanstack-start-app`):

```sh
cd <path>/more-or-less-admin
npx wrangler secret put OPS_ASSISTANT_SECRET
# paste SECRET when prompted
```

Or: Cloudflare Dashboard → Workers → **`tanstack-start-app`** → Settings → Variables and Secrets → add secret `OPS_ASSISTANT_SECRET`.

Verify the API gate (expect `200` JSON, not `503` / `401`):

```sh
curl -sS -o /tmp/ops-health.json -w "%{http_code}\n" \
  -H "Authorization: Bearer $SECRET" \
  -H "Accept: application/json" \
  "https://ops.snaptapp.us/api/internal/ops/factbank/health"
cat /tmp/ops-health.json
```

- `503` + `OPS_ASSISTANT_SECRET is not configured.` → Admin secret missing/wrong Worker.
- `401` → wrong secret value.
- `200` → Admin side OK. Proceed.

---

## Step 3 — Notion Fact Bank worker

```sh
export PATH="$HOME/.local/bin:$PATH"
cd <path>/more-or-less-admin/notion-workers/more-or-less-factbank

# If no workers.json yet (or env set fails with "No worker ID"):
ntn workers deploy
# Workspace: Trackdub 01454199-cd94-8168-873e-00038ccb0750
# Worker name: more-or-less-factbank

ntn workers env set OPS_API_BASE_URL=https://ops.snaptapp.us OPS_ASSISTANT_SECRET="$SECRET"
```

If `env set` still asks for workspace, pick **`01454199-…0750`** again.

Optional smoke via Notion CLI (if available):

```sh
ntn workers exec factbank_health --local -d '{}'
# or remote exec equivalent after env is set
```

---

## Step 4 — Wire the Custom Agent (Notion UI; Tony may need to click)

Notion MCP **cannot** edit Custom Agent instructions or attach Workers. Do this in the Notion UI:

1. Open **More-or-Less Ops Assistant** in workspace `01454199-…`.
2. Settings → **Tools and access** → connect worker **more-or-less-factbank** → enable:
   - `factbank_health`
   - `factbank_breakdown`
   - `factbank_validate`
   - `factbank_duplicates`
   - `factbank_drift`
   - `factbank_inspect`
   - `mol_system_snapshot`
3. Settings → **Instructions** → replace with contents of  
   `notion-workers/AGENT_INSTRUCTIONS.md` (Tony also has this pasted locally).
4. Disable unrelated tools that trigger `adminUserConnections` if they aren’t needed. Known failure Tony hit:

   ```text
   Tool input failed validation: adminUserConnections requires a non-empty explanation.
   ```

   That is a **Notion platform** tool, not our Fact Bank worker. Prefer prompting: “Call `factbank_health` and summarize.”

---

## Step 5 — End-to-end acceptance

In the agent chat:

1. “Call `factbank_health` and summarize overall state.”
2. “Call `mol_system_snapshot`.”

Pass criteria:

- Agent actually invokes the Fact Bank tools (not inventing from docs).
- No secret / 401 / 503 errors in tool results.
- Answer cites live counts / timestamps.

If tools return Ops API errors, fix Admin/Notion secrets (Steps 2–3) before touching agent copy again.

---

## Optional — Cloudflare state inspector

Same pattern under `notion-workers/cloudflare-state-inspector`:

```sh
cd ../cloudflare-state-inspector
ntn workers deploy   # same workspace 01454199-…
ntn workers env set CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
```

Then connect that worker on the same agent. Needed for `production_health` etc. **Not** required for Fact Bank-only smoke test.

---

## Do not

- Recreate PR-scoped GitHub babysitter routines (rate limits).
- Set `OPS_ASSISTANT_ALLOW_CRON_FALLBACK` in prod.
- Deploy to the wrong Trackdub workspace.
- Put secrets in git, PR bodies, or committed `.env`.
- Keep re-running `secret put` / `env set` without a failing `curl` / tool result that proves mismatch.

---

## Report back to Tony

When done, one short message:

1. Admin `curl` HTTP status for `/factbank/health`
2. Notion worker env set confirmed (yes/no)
3. Agent tools connected (yes/no)
4. Instructions pasted (yes/no)
5. Smoke test result (pass/fail + error text if fail)

Do **not** include the secret value in the report.
