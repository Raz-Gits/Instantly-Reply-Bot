# Instantly Reply Bot

Receives `reply_received` webhooks from [Instantly.ai](https://instantly.ai), classifies each reply with OpenAI, and routes it to exactly one of three outcomes:

| Outcome | When | What happens |
| --- | --- | --- |
| **ignore** | Bare opt-outs (`stop`, `remove me`), simple declines, out-of-office, auto-replies | Logged and dropped. No notification. |
| **draft** | Intent matches a reply template *and* confidence ≥ threshold | Template rendered with the lead's details, posted to Discord for you to approve and send. |
| **alert** | Positive/engaged reply with no matching template, an objection, a complex negative, or low confidence | Posted to Discord with the reply, the classification, and why it needs you. |

Nothing is sent to a prospect automatically — the bot drafts, you send.

## How a reply flows

```
Instantly webhook
  → normalize   strip quoted history & signatures, flatten lead fields
  → classify    rules fast-path for bare opt-outs, else OpenAI structured output
  → decide      ignore / draft / alert
  → notify      Discord embed (draft or alert)
```

Each stage lives in its own module: [normalize.ts](src/core/normalize.ts), [classify/](src/classify/), [decide.ts](src/core/decide.ts), [discord.ts](src/integrations/discord.ts), wired together in [pipeline.ts](src/core/pipeline.ts).

## Setup

```bash
npm install
cp .env.example .env   # then fill it in
npm run dev
```

Required env vars — see [.env.example](.env.example) for the full list:

- `WEBHOOK_SECRET` — a long random string; Instantly must send it back
- `OPENAI_API_KEY` — classification
- `DISCORD_WEBHOOK_URL` — where drafts and alerts land
- `CALENDAR_LINK`, `SENDER_NAME` — filled into templates

`INSTANTLY_API_KEY` is optional and unused in draft-only mode. Add it when you want lead enrichment or auto-send.

### Point Instantly at it

In Instantly: **Settings → Integrations → Webhooks → Add webhook**

- Event: `Reply Received`
- URL: `https://your-host/webhooks/instantly`
- Header: `X-Webhook-Secret: <your WEBHOOK_SECRET>`

If Instantly's UI won't let you set a custom header on your plan, append the secret as a query param instead: `https://your-host/webhooks/instantly?secret=<your WEBHOOK_SECRET>`.

The endpoint replies `202` immediately and processes out of band, so a slow OpenAI call never triggers an Instantly redelivery.

## Reply templates

Templates live in [src/templates/registry.ts](src/templates/registry.ts). Each declares the intents it answers:

```ts
{
  id: 'meeting_request',
  intents: ['meeting_request'],
  subject: 'Re: {{originalSubject}}',
  body: `Hi {{firstName}}, ...`,
}
```

Shipped: `meeting_request`, `pricing_request`, `interested_generic`, `referral`, `wrong_person`, `follow_up_later`.

**Any intent with no template escalates to Discord instead.** That's the designed fallback, so deleting a template is safe — it turns those replies into alerts, never into silence.

Available placeholders: `firstName`, `lastName`, `fullName`, `companyName`, `email`, `website`, `phone`, `originalSubject`, `campaignName`, `senderName`, `senderCompany`, `calendarLink`, plus any custom lead variable Instantly includes in the payload.

`firstName`, `companyName`, and `originalSubject` fall back to friendly defaults when blank ("there", "your team"). Any *other* placeholder that resolves empty aborts the draft and sends an alert instead — better a human handles it than a prospect receives `{{calendarLink}}`.

## Intents

`interested`, `meeting_request`, `pricing_request`, `info_request`, `referral`, `wrong_person`, `not_now_follow_up_later`, `objection`, `not_interested`, `unsubscribe`, `out_of_office`, `auto_reply`, `unclear`.

Two flags drive routing alongside the intent:

- **`confidence`** — below `CONFIDENCE_THRESHOLD` (default 0.7) the reply goes to a human regardless of intent.
- **`isComplexNegative`** — a negative reply carrying a reason, question, or complaint. Always alerts, even for `unsubscribe`, so an angry "remove me and stop buying lists" doesn't get silently dropped.

## Testing locally

Replay a sample payload against the pipeline without a server or an Instantly account:

```bash
npx tsx scripts/replay.ts "Sounds interesting - can we talk Thursday?"
npx tsx scripts/replay.ts "unsubscribe"
```

Run the suite:

```bash
npm test
npm run typecheck
```

Tests cover the routing matrix ([decide.test.ts](test/decide.test.ts)) and the rules fast-path plus quoted-reply stripping ([classify.rules.test.ts](test/classify.rules.test.ts)). Neither hits the network.

## Failure behaviour

- **OpenAI down or returns garbage** → reply is classified `unclear` at confidence 0 → alerts to Discord. Replies degrade to "a human reads it", never to lost.
- **Discord down** → logged, still `202` to Instantly. The reply is not retried.
- **Bad secret** → `401`. **Malformed payload** → `400` (not `500`, since redelivering it won't help).

## Enabling auto-send later

[instantly.ts](src/integrations/instantly.ts) has a working `sendReply` that is deliberately not called. To flip it on, call it from the `draft` branch of [pipeline.ts](src/core/pipeline.ts) and set `INSTANTLY_API_KEY`. Consider restricting it to a subset of templates first.
