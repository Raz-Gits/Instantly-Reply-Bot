# Instantly Reply Bot

Answers replies to cold email campaigns run in [Instantly.ai](https://instantly.ai). It listens for Instantly's `reply_received` webhook (one webhook URL per client workspace), classifies each reply with OpenAI, and acts through Instantly's real v2 API. Every reply ends in exactly one of three outcomes:

| Outcome | When | What happens |
| --- | --- | --- |
| **ignore** | Bare opt-outs (`stop`, `remove me`), simple declines, out-of-office, auto-replies | Logged and dropped. Opt-outs and declines are also marked unsubscribed in that client's Instantly workspace. |
| **draft** | Intent matches a reply template, confidence ≥ threshold, no escalation flags | Template rendered with the lead's details and the client's profile, posted to that client's Discord channel for approval. |
| **alert** | Everything a human should see: no matching template, objections, referrals, complex negatives, escalation flags, long replies, low confidence | Posted to Discord with the reply, the classification, and why it needs you. |

This public version sends nothing to a prospect on its own: the bot drafts, you send. In production the defined cases went out automatically; see [Turning on auto-send](#turning-on-auto-send).

## Multi-client architecture

Each client (Instantly workspace) gets:

- **Their own webhook URL:** `POST /webhooks/instantly/<slug>`. The slug selects the profile; no campaign-ID bookkeeping.
- **A profile in `config/clients.json`:** calendar link, sender name, pitch (`whatWeDo`), pricing copy (`pricingInfo`), differentiator, Discord sub-channel webhook, and the *name* of the env var holding their Instantly API key. See [config/clients.example.json](config/clients.example.json).
- **Optional template customization:** per-template copy overrides and a `disabledTemplates` list.

A webhook hitting an unknown slug still gets classified, but **never drafts** (it can't know whose calendar to offer). It alerts to the global Discord channel as "unconfigured webhook" instead. Onboarding a client = add a profile, create their Discord channel webhook, set their API key env var, point their Instantly workspace at their URL.

`config/clients.json` is gitignored (it contains Discord webhook URLs). Copy the example and fill it in, or put the whole JSON in the `CLIENTS_JSON` env var on hosts without a persistent disk.

## How a reply flows

```
Instantly webhook (per-client URL)
  → normalize   strip quoted history & signatures, flatten lead fields
  → classify    rules fast-path for bare opt-outs, else OpenAI structured output
  → decide      ignore / draft / alert  (+ mark-unsubscribed side effect)
  → notify      Discord embed in the client's sub-channel
```

Each stage lives in its own module: [normalize.ts](src/core/normalize.ts), [classify/](src/classify/), [decide.ts](src/core/decide.ts), [discord.ts](src/integrations/discord.ts), wired together in [pipeline.ts](src/core/pipeline.ts).

## Routing rules (in evaluation order)

1. **Ignore + unsubscribe**: bare `unsubscribe` / `not_interested` replies are dropped and the lead is added to that workspace's block list via the Instantly API. OOO and auto-replies are dropped without the API call.
2. **Complex negatives alert**: any negative reply with substance (a reason, a complaint, anger), even an angry unsubscribe, which *also* still gets the unsubscribe API call.
3. **Deterministic guards** (from the reply playbook): more than 150 words / 900 characters, or more than 2 questions → alert. Counted in code, not judged by the model.
4. **Escalation flags** → alert regardless of intent: `named_competitor`, `referral_mention`, `existing_relationship`, `legal_or_contract`, `negotiation_terms`, `technical_deep_dive`, `press_media`, `sensitive_info`.
5. **Always-alert intents**: `referral` (both directions, handled personally), `objection`, `unclear`.
6. **Low confidence** (< `CONFIDENCE_THRESHOLD`, default 0.7) → alert.
7. **Template lookup** under the client's config → draft, or alert if no template / template disabled / a needed profile field is blank.

That last point is a feature: a client with an empty `pricingInfo` simply has pricing replies escalated to Discord instead of auto-drafted. Blank fields degrade to human handling, never to broken drafts.

## Templates

Defaults live in [src/templates/registry.ts](src/templates/registry.ts), copy from the reply playbook:

| id | intents | needs profile field |
| --- | --- | --- |
| `book_call` | interested, meeting_request | calendarLink |
| `what_we_do` | info_request | whatWeDo, calendarLink |
| `pricing` | pricing_request | pricingInfo, calendarLink |
| `proof` | proof_request | calendarLink |
| `how_found_you` | how_did_you_find_us | none |
| `existing_provider` | existing_provider | differentiator, calendarLink |
| `follow_up_later` | not_now_follow_up_later | none (timeframe extracted from the reply) |
| `wrong_person` | wrong_person | none |

Placeholders: `firstName`, `lastName`, `fullName`, `companyName` (the **prospect's** company), `ourCompanyName` (the client's), `email`, `website`, `phone`, `originalSubject`, `campaignName`, `senderName`, `clientName`, `calendarLink`, `whatWeDo`, `pricingInfo`, `differentiator`, `followUpTimeframe`, plus any custom lead variable from the Instantly payload.

`firstName`, `companyName`, `originalSubject`, and `followUpTimeframe` soften to friendly defaults when blank; any other blank placeholder aborts the draft and alerts instead.

## Setup

```bash
npm install
cp .env.example .env                              # fill in
cp config/clients.example.json config/clients.json # fill in
npm run dev
```

Global env vars: `WEBHOOK_SECRET`, `OPENAI_API_KEY`, `DISCORD_WEBHOOK_URL` (catch-all channel), `CONFIDENCE_THRESHOLD`, plus one `INSTANTLY_API_KEY_<CLIENT>` per workspace (names declared in clients.json).

### Point each Instantly workspace at its URL

In that workspace: **Settings → Integrations → Webhooks → Add webhook**

- Event: `Reply Received`
- URL: `https://your-host/webhooks/instantly/<slug>`
- Header: `X-Webhook-Secret: <your WEBHOOK_SECRET>` (or append `?secret=...` if your plan hides custom headers; the server masks that value in its own logs, but a proxy in front of it may not)

The endpoint replies `202` immediately and processes out of band, so a slow OpenAI call never triggers an Instantly redelivery.

## Testing locally

```bash
npx tsx scripts/replay.ts --client raz "Sounds interesting - can we talk Thursday?"
npx tsx scripts/replay.ts --client acme --dry "how much does it cost?"
npm test && npm run typecheck
```

The suite covers the full routing matrix, per-client overrides, the playbook guards, and quoted-reply stripping, with no network access needed.

## Failure behaviour

- **OpenAI down** → reply classified `unclear` at confidence 0 → alert. Replies degrade to "a human reads it", never to lost.
- **Unsubscribe API call fails** → a warning posts to the client's Discord channel asking for a manual unsubscribe. No key configured → skipped with a log line.
- **Discord down** → logged, still `202` to Instantly.
- **Unknown webhook slug** → classified + alerted to the global channel, never drafted.
- **Bad secret** → `401`. **Malformed payload** → `400`.

## Using it with a different email tool

It's built for Instantly, but only three files know that:

- [normalize.ts](src/core/normalize.ts) turns Instantly's webhook payload into a plain `ReplyEvent`. Map your tool's payload here.
- [instantly.ts](src/integrations/instantly.ts) holds the two outbound calls: adding a lead to the block list, and sending a reply. Swap in your tool's endpoints.
- [server.ts](src/server.ts) exposes `POST /webhooks/instantly/:slug` and checks the shared secret. Rename the route if you like.

Everything else works the same whatever sent the email: the rules, the OpenAI classifier, the routing, the templates, the dedupe and the Discord alerts.

## Turning on auto-send

In production, the defined cases replied automatically through `sendReply` in [instantly.ts](src/integrations/instantly.ts), which calls Instantly's `/emails/reply` endpoint. It started switched off. While testing, every draft went to Discord to be confirmed by hand. Once a client's edge cases were known, the `draft` branch of [pipeline.ts](src/core/pipeline.ts) called `sendReply`, so a reply that cleared every guard was answered in minutes and everything else still came to Discord.

This public version ships with that call removed, so nobody who forks it emails prospects by accident. To turn it on for your own workspace, run it with sending off until you trust the drafts, then call `sendReply` from the `draft` branch. A reply only reaches that branch when it carries no escalation flag, is under 150 words, asks at most two questions, isn't an objection or a referral, clears the confidence threshold, and has a template with every field it needs.
