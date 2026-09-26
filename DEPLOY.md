# Deploying to production (Railway)

Everything below uses placeholders. Nothing in this file is a real credential.
Time to first live webhook: about an hour.

## 1. Create the Railway service

1. railway.app → New Project → **Deploy from GitHub repo** → select this repo,
   branch `main` (merge `production-deploy` first).
2. Railway reads `railway.json`: Dockerfile build, `/health` healthcheck,
   restart-on-failure. No other build settings needed.

## 2. Set environment variables

Service → Variables. The server fails fast with a named error for anything
missing or malformed (see `src/core/config.ts`), so a bad deploy dies at boot,
not at the first webhook.

| Variable | Value | Notes |
|---|---|---|
| `WEBHOOK_SECRET` | `<64-char-random>` | Generate: `openssl rand -hex 32`. Never reuse another secret. |
| `OPENAI_API_KEY` | `sk-proj-...` | A key scoped to this app, not your personal default key. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Default; override only deliberately. |
| `DISCORD_WEBHOOK_URL` | `https://discord.com/api/webhooks/<id>/<token>` | Catch-all channel; also receives pipeline-failure alerts. |
| `INSTANTLY_API_KEY_RAZ` | `<instantly-api-key>` | Instantly → Settings → Integrations → API. One var per workspace; the var *name* is declared in `CLIENTS_JSON` (`instantlyApiKeyEnv`). |
| `CLIENTS_JSON` | see below | Replaces `config/clients.json` on hosts without a persistent file. |
| `LOG_LEVEL` | `info` | |

`CLIENTS_JSON` for a single workspace (minified onto one line when pasting):

```json
{
  "raz": {
    "clientName": "<Your campaign name>",
    "senderName": "<Your first name>",
    "calendarLink": "https://cal.com/<you>/<event>",
    "whatWeDo": "<one sentence describing the offer, used in drafts>",
    "discordWebhookUrl": "https://discord.com/api/webhooks/<id>/<token>",
    "instantlyApiKeyEnv": "INSTANTLY_API_KEY_RAZ"
  }
}
```

`clientName`, `senderName` and `calendarLink` are required. Every other field,
including pricing copy and per-template overrides, is shown in
[config/clients.example.json](config/clients.example.json). Profiles are
validated when they load, and a missing or malformed field fails with its name.

## 3. Point Instantly at it

Instantly → workspace → **Settings → Webhooks → Add webhook**:

- Event: `reply_received`
- URL: `https://<service>.up.railway.app/webhooks/instantly/raz`
- Header: `X-Webhook-Secret: <WEBHOOK_SECRET>`

The server also accepts the secret on the URL as `?secret=<WEBHOOK_SECRET>`,
for setups that can't send a header. It masks that value in its own logs,
but a proxy or host in front of it may still record full URLs, so use the
header when you can. Instantly's help center lists an optional headers field
on its webhook form.

## 4. Verify

```bash
# 1. Server is up and the client profile loaded:
curl https://<service>.up.railway.app/health
# -> {"status":"ok","uptime":...,"clientCount":1}

# 2. Bad secret is rejected:
curl -s -o /dev/null -w "%{http_code}" -X POST \
  https://<service>.up.railway.app/webhooks/instantly/raz \
  -H 'content-type: application/json' -d '{}'
# -> 401

# 3. Full pipeline with no Instantly needed, replaying a reply locally:
npx tsx scripts/replay.ts --client raz "Sounds interesting - can we talk Thursday?"
# (or send yourself a campaign email and reply to it, then watch Discord)
```

Send-yourself test: add your own address as a lead in a test campaign, reply
to the email, and the draft should appear in the Discord channel within a few
seconds. That reply → Discord round-trip is the demo.

## 5. Operational notes

- **Duplicates:** redeliveries inside a 6-hour window are acked (`202
  duplicate`) and dropped. The ledger is in memory, capped at 2,000 entries
  (`src/core/dedupe.ts`). A restart forgets the ledger; the worst case is a
  repeated Discord post, never a lost reply.
- **Pipeline failures page a human:** any error after the ack posts a 🚨 to the
  client's Discord channel naming the lead, because Instantly will never retry
  an acked delivery. If you see one, the reply still needs manual handling in
  the Unibox.
- **Auto-send stays off.** `sendReply` exists and is intentionally never
  called; the one automated write is the unsubscribe (compliance action). Keep
  it that way until a human has reviewed drafts for a few weeks.
- **Known limit:** an event that arrives in the instant between ack and
  processing during a crash/redeploy is acked but unprocessed. At current
  volume this is an accepted trade-off; the durable fix (write-ahead table in
  Supabase) is sketched in the repo issues.
- **Rotate** `WEBHOOK_SECRET` by setting a new value and updating the Instantly
  webhook header (or URL) in the same sitting; the old value dies the moment
  the var changes. Rotate it before going live again if it was ever sent as
  `?secret=`, since older logs may hold it.
