# Notion Workers for More-or-Less Ops Assistant

Read-only tool Workers for the Notion Custom Agent **More-or-Less Ops Assistant**.

## Architecture

```text
Notion Custom Agent
        ↓ tools
Notion Workers (this folder)
        ↓
Admin Ops API  GET /api/internal/ops/factbank/*
        ↓
same Admin domain logic (Firestore + GAME_WORKER_URL bank stamp)

Cloudflare State Inspector Worker
        ↓
Cloudflare API (allowlisted projects only)
```

Do **not** reimplement Fact Bank validation inside Notion Workers. The Admin Ops API is the authority.

## Workers

| Worker | Tools |
| --- | --- |
| `more-or-less-factbank` | `factbank_health`, `factbank_breakdown`, `factbank_validate`, `factbank_duplicates`, `factbank_drift`, `factbank_inspect`, `mol_system_snapshot`, `moderation_queue`, `moderation_copilot`, `moderation_act`, `crawl_queue`, `players_search`, `players_player`, `players_premium`, `daily_schedule`, `daily_day`, `daily_delete`, `daily_remove_score`, `daily_fill`, `daily_generate`, `daily_publish`, `analytics_games`, `analytics_questions`, `analytics_flag`, `config_read`, `config_publish`, `roles_list`, `audit_log` |
| `cloudflare-state-inspector` | `production_health`, `deployment_history`, `worker_health`, `binding_inventory`, `kv_summary`, `d1_summary`, `r2_summary`, `recent_runtime_errors` |

## Deploy

```sh
# one-time
export PATH="$HOME/.local/bin:$PATH"
ntn login

# Fact Bank tools
cd more-or-less-factbank
ntn workers env set OPS_API_BASE_URL=https://ops.snaptapp.us OPS_ASSISTANT_SECRET=...
ntn workers deploy

# Cloudflare inspector
cd ../cloudflare-state-inspector
ntn workers env set CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
ntn workers deploy
```

Then in Notion: open **More-or-Less Ops Assistant** → Settings → Tools and access → connect both Workers and enable the tools.

Also set Admin Worker secret `OPS_ASSISTANT_SECRET` on `ops.snaptapp.us` (do not reuse `OPS_CRON_SECRET` in production).

## Local tool exec

```sh
cd more-or-less-factbank
cp .env.example .env   # if present; or create .env with OPS_* keys
ntn workers exec factbank_health --local -d '{}'
```

## Agent instructions

Paste the contents of `AGENT_INSTRUCTIONS.md` into the Custom Agent Settings → Instructions.
