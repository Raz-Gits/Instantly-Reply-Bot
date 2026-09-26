# Codex adversarial review, 2026-09-26

- **Reviewer:** Codex (OpenAI) CLI 0.153.0-alpha.5, read-only sandbox
- **Run:** 2026-09-26, against commit `eb16c28`
- **Prompt:**

> Do an adversarial review of this repository. Assume it runs in production on real prospects' inboxes, with auto-send switched on for the draft branch. Find what can go wrong: a wrong or duplicate email reaching a prospect, an opt-out not honored, the webhook accepting a forged request, secrets leaking into logs, a failure that stays silent, a path with no test. For each finding give the file and line, what can go wrong, why the code allows it, the likely impact, a concrete fix, and your confidence from 0 to 1. Start with a verdict: SHIP, FIX_THEN_SHIP or NO-SHIP. Do not modify any files. Output the full review in Markdown as your final message.

Codex's text below is verbatim; only its file links were changed from local paths to repo-relative ones.

The line numbers in those links are from commit `eb16c28`. The files have changed since, so on a later commit a link may not land on the line Codex meant.

---

# Verdict: NO-SHIP

Under the stated assumption that every `draft` decision is auto-sent, this repository is not safe for production prospect inboxes.

The largest risks are:

- Auto-send behavior is absent from the reviewed revision, so the real production path is unreviewed.
- Duplicate sends are possible after restarts, concurrent instances, timeouts, and delayed redeliveries.
- The webhook secret is placed in URLs and is demonstrably written to request logs.
- A leaked shared secret permits forged events across every configured client.
- Events are acknowledged before durable processing, allowing replies and opt-outs to disappear permanently.
- Opt-out failures can be recorded as successful and remain operationally silent.
- The send decision ultimately depends on an untrusted LLM classification, with no final suppression check.
- No test exercises the webhook-to-send or webhook-to-unsubscribe path.

## Blast-radius assessment

| Property | Assessment |
|---|---|
| Blast radius | Every lead reachable through every configured Instantly workspace |
| Worst plausible input | A forged or replayed webhook flood that produces draftable classifications and sends arbitrary replies |
| Detection window | Potentially indefinite; logs and Discord are the only signals, and Discord failures are swallowed |
| Report-only default | No, under the assumed production wiring |
| Idempotent | No durable idempotency |
| Human gate | None on the auto-send branch |
| Reversible | No; sent email is irreversible |
| Exclusions | Opt-outs are acted on after classification, but no authoritative exclusion is checked immediately before sending |
| Alarm | No reliable alarm, heartbeat, queue-depth check, failed-send reconciliation, or volume anomaly alert |

## Findings

### 1. Critical — The production auto-send path is not present in the reviewed source

**File and line:** [src/core/pipeline.ts:32](../src/core/pipeline.ts#L32), [src/integrations/instantly.ts:100](../src/integrations/instantly.ts#L100), [README.md:117](../README.md#L117)

**What can go wrong:** The code actually running in production can differ materially from the reviewed and tested repository. Its parameter mapping, error handling, send ordering, and retry behavior are unknown.

**Why the code allows it:** `processWebhook` creates and posts drafts but never imports or invokes `sendReply`. The README explicitly says the public source has the call removed. Neither `main` nor `origin/production-deploy` contains the production send integration.

**Likely impact:** A production-only change can send to the wrong address, send malformed messages, retry incorrectly, or bypass safeguards without CI or review catching it.

**Concrete fix:** Put the exact auto-send implementation in version control. Gate it behind an explicit, default-off `AUTO_SEND=false`, preferably per client. Add a reviewed `sendDraft` stage with durable idempotency, final suppression checks, audited parameter mapping, and integration tests. Deploy only reviewed commits.

**Confidence:** 1.00

---

### 2. Critical — The webhook secret leaks into normal request logs

**File and line:** [src/server.ts:21](../src/server.ts#L21), [src/server.ts:34](../src/server.ts#L34), [DEPLOY.md:49](../DEPLOY.md#L49)

**What can go wrong:** Anyone with access to application, proxy, platform, browser-history, or observability logs can recover the webhook credential.

**Why the code allows it:** Authentication accepts `?secret=...`, deployment instructions recommend that form, and Fastify’s default request logger records the complete request URL. I verified locally that a request to `/hook?secret=TEST_SECRET_123` logs that secret verbatim.

**Likely impact:** Credential compromise enables forged webhooks and, with auto-send active, prospect-facing email under any configured client identity.

**Concrete fix:** Stop accepting secrets in query parameters. Use a header only, configure Pino request serializers/redaction defensively, and verify redaction at the reverse proxy and hosting platform too. Rotate the current secret because it may already exist in retained logs.

**Confidence:** 1.00

---

### 3. Critical — A leaked credential permits forged events across all clients

**File and line:** [src/server.ts:18](../src/server.ts#L18), [src/server.ts:36](../src/server.ts#L36), [src/core/types.ts:9](../src/core/types.ts#L9), [src/integrations/instantly.ts:111](../src/integrations/instantly.ts#L111)

**What can go wrong:** An attacker can submit a fabricated “positive reply” for a chosen client, lead email, campaign, and sending account. The resulting draft can be sent as a real reply.

**Why the code allows it:**

- A single static bearer secret authenticates every client.
- The public health endpoint enumerates client slugs.
- There is no signed-body verification, timestamp freshness check, nonce, or replay protection beyond a six-hour in-memory cache.
- `event_type` is optional and never checked.
- Nearly every payload field is optional, and unknown fields are accepted.
- The downstream API call trusts payload-derived campaign, lead, and email-account identifiers.

This proves only possession of a shared string, not that Instantly generated the body.

**Likely impact:** Unauthorized email, cross-client abuse, brand damage, disclosure of client-specific copy, and possible mass sending/API cost.

**Concrete fix:** Use a unique high-entropy secret per client and header-only transport. If Instantly supports webhook signatures, verify the raw body with its signing secret and enforce a timestamp window. Otherwise place a verifying gateway in front. Require `event_type === "reply_received"`, validate all send-critical fields, bind campaign/account identifiers to the selected client, and add rate limiting.

**Confidence:** 0.99

---

### 4. Critical — Duplicate sends are not durably prevented

**File and line:** [src/core/dedupe.ts:16](../src/core/dedupe.ts#L16), [src/core/dedupe.ts:20](../src/core/dedupe.ts#L20), [src/server.ts:62](../src/server.ts#L62), [src/integrations/instantly.ts:104](../src/integrations/instantly.ts#L104)

**What can go wrong:** The same reply can cause multiple emails.

**Why the code allows it:**

- Deduplication is process-local memory.
- A restart forgets all keys.
- Multiple replicas have independent ledgers.
- Keys expire after six hours.
- Eviction starts at 2,000 entries.
- A delivery with a changed timestamp or body representation gets a different key.
- `sendReply` supplies no idempotency key.
- A timeout is ambiguous: Instantly may have accepted the email even though this process sees failure.

The comments saying the worst case is a repeated Discord post cease to be true once auto-send is enabled.

**Likely impact:** A prospect receives duplicate replies, potentially minutes or hours apart. Automated/manual recovery can create further duplicates.

**Concrete fix:** Add a durable database-backed event/outbox ledger with a stable provider event or message ID. Give each intended send a unique idempotency key and persist states such as `received`, `classified`, `send_started`, `sent`, and `failed`. Reconcile ambiguous timeouts with the provider before retrying. Use a uniqueness constraint, not check-then-insert application logic.

**Confidence:** 1.00

---

### 5. Critical — The endpoint acknowledges work before it is durable

**File and line:** [src/server.ts:62](../src/server.ts#L62), [src/server.ts:68](../src/server.ts#L68), [src/server.ts:73](../src/server.ts#L73)

**What can go wrong:** A prospect reply—including an opt-out—can be acknowledged and then never classified, unsubscribed, alerted, or answered.

**Why the code allows it:** The server returns `202` and only then performs processing in memory. A crash, redeploy, forced shutdown, or process termination in that interval loses the event. There is no durable queue or write-ahead record. Instantly will not retry a successful `202`.

Additionally, the dedupe key is recorded before processing, so an immediate manual retry on the same instance can be discarded even if the original pipeline failed.

**Likely impact:** Lost opt-outs, ignored interested prospects, and compliance incidents with no recoverable work item.

**Concrete fix:** Persist the authenticated event transactionally before returning `2xx`, then process it from a durable queue/outbox. Return success only after persistence. Keep failed items with attempt counts, visible status, and a dead-letter workflow.

**Confidence:** 1.00

---

### 6. Critical — There is no authoritative suppression check immediately before sending

**File and line:** [src/core/pipeline.ts:29](../src/core/pipeline.ts#L29), [src/core/pipeline.ts:41](../src/core/pipeline.ts#L41), [src/integrations/instantly.ts:104](../src/integrations/instantly.ts#L104)

**What can go wrong:** The bot can email someone who has already opted out, including when an opt-out event and a positive-looking event are processed concurrently.

**Why the code allows it:** Suppression is derived solely from the current reply’s classification. The outbound function does not check an append-only local suppression ledger or the authoritative workspace block list immediately before the irreversible send. There is also no per-lead serialization.

**Likely impact:** Direct opt-out violations, complaints, spam reports, and legal/compliance exposure.

**Concrete fix:** Record every opt-out durably and append-only before acknowledging it. At the final send boundary, atomically verify that the lead is not suppressed. Serialize state transitions per workspace and normalized email address. Treat any inability to verify suppression as “do not send.”

**Confidence:** 0.96

---

### 7. High — Failed or impossible opt-outs can remain silent and be logged as successful

**File and line:** [src/core/pipeline.ts:41](../src/core/pipeline.ts#L41), [src/core/pipeline.ts:43](../src/core/pipeline.ts#L43), [src/core/pipeline.ts:48](../src/core/pipeline.ts#L48), [src/core/pipeline.ts:68](../src/core/pipeline.ts#L68), [src/integrations/instantly.ts:64](../src/integrations/instantly.ts#L64)

**What can go wrong:** An opt-out is not applied, nobody is reliably alerted, and operational logs still say `"unsubscribed": true`.

**Why the code allows it:**

- Missing lead email or missing API configuration produces `skipped`.
- `skipped` only emits `console.warn`, even though the reply is then ignored.
- API failures post to Discord, but the return value of that post is ignored.
- Discord notification failures are deliberately swallowed.
- The final log records the decision flag, not whether the API operation succeeded.

**Likely impact:** Operators believe suppression succeeded while the prospect remains contactable. Future campaigns or the auto-reply path may email them again.

**Concrete fix:** Track actual outcomes separately: `unsubscribe_requested`, `unsubscribe_confirmed`, and `unsubscribe_failed`. Missing identity must create a durable high-priority work item. Failed alerts must page through an independent monitored channel, and unresolved opt-outs must block future sends.

**Confidence:** 1.00

---

### 8. High — Untrusted model output is being used as send authorization

**File and line:** [src/classify/openai.ts:35](../src/classify/openai.ts#L35), [src/classify/openai.ts:77](../src/classify/openai.ts#L77), [src/classify/rules.ts:89](../src/classify/rules.ts#L89), [src/core/decide.ts:113](../src/core/decide.ts#L113)

**What can go wrong:** A negative, opt-out, legal, or adversarial reply can be classified with high confidence as draftable and receive an automated sales response.

**Why the code allows it:**

- Prospect-controlled text is placed directly into an LLM prompt.
- Confidence is self-reported by the same model making the classification.
- The deterministic opt-out layer only recognizes exact short phrases.
- Variants such as “please stop contacting our company” or multilingual opt-outs depend on the model.
- There is no independent post-classification deny layer scanning for opt-out, threat, legal, or prompt-injection indicators.

Structured output restricts the response shape; it does not make the classification trustworthy.

**Likely impact:** An angry or opted-out prospect receives another sales email. Prompt injection can deliberately force unsafe routing.

**Concrete fix:** Treat model output as evidence, not authorization. Add conservative deterministic suppression and escalation detectors before and after classification, including normalized opt-out variants and supported languages. Calibrate the model on a labeled adversarial set. Require human review until measured false-send rates meet an explicit threshold.

**Confidence:** 0.95

---

### 9. High — Send-critical payload fields are optional and insufficiently bound

**File and line:** [src/core/types.ts:9](../src/core/types.ts#L9), [src/core/normalize.ts:98](../src/core/normalize.ts#L98), [src/integrations/instantly.ts:113](../src/integrations/instantly.ts#L113)

**What can go wrong:** The system may attempt to send with missing, stale, forged, or mismatched lead, campaign, and sending-account identifiers.

**Why the code allows it:** The webhook schema makes email, campaign ID, account, reply body, timestamp, and event type optional. Normalization silently turns missing values into empty strings. No stage establishes invariants such as “this campaign and sending account belong to this client” before passing them to the outbound API.

**Likely impact:** At best, the provider rejects the request after the webhook is already acknowledged. At worst, a forged or ambiguous payload targets the wrong lead or conversation.

**Concrete fix:** Introduce an auto-send-specific schema requiring a normalized email, campaign ID, sending account, provider event/message ID, reply content, and valid timestamp. Resolve or verify the thread through the provider API and confirm that campaign/account membership belongs to the selected client.

**Confidence:** 0.98

---

### 10. High — Auto-send has no kill switch, volume cap, or anomaly circuit breaker

**File and line:** [src/core/config.ts:4](../src/core/config.ts#L4), [src/core/pipeline.ts:32](../src/core/pipeline.ts#L32)

**What can go wrong:** A classifier regression, forged webhook flood, bad client configuration, or template mistake can continue emailing prospects until a person notices manually.

**Why the code allows it:** There is no default-off send flag, per-client rollout state, hourly cap, consecutive-failure breaker, template-version allowlist, canary mode, or automated shutdown condition.

**Likely impact:** The blast radius is bounded primarily by campaign/workspace limits rather than this application. A single bad deploy can affect the entire prospect population.

**Concrete fix:** Add a default-off global switch plus per-client enablement. Enforce per-client and global send-rate ceilings, a small initial canary quota, automatic shutdown on abnormal classification/send rates, and an operational kill switch that does not require redeployment.

**Confidence:** 0.98

---

### 11. High — The irreversible webhook, unsubscribe, and send paths have no tests

**File and line:** [src/server.ts:44](../src/server.ts#L44), [src/core/pipeline.ts:24](../src/core/pipeline.ts#L24), [src/integrations/instantly.ts:60](../src/integrations/instantly.ts#L60), [vitest.config.ts:4](../vitest.config.ts#L4)

**What can go wrong:** Regressions in authentication, acknowledgement ordering, payload validation, opt-out failure handling, client isolation, API request construction, and duplicate prevention reach production undetected.

**Why the code allows it:** The four test files cover rule classification, normalization, decision logic, client configuration, and the in-memory dedupe primitive. Nothing imports or exercises:

- `buildServer`
- `processWebhook`
- `markLeadUnsubscribed`
- `sendReply`
- Discord failure handling
- OpenAI response parsing
- The assumed auto-send branch

The README’s statement that the suite covers the “full routing matrix” does not cover the actual side-effect boundary.

**Likely impact:** The most damaging paths are precisely the paths CI never executes.

**Concrete fix:** Add server injection tests for authentication and strict payload rejection; pipeline tests with mocked external APIs; exact request-body tests for sending and unsubscribing; crash/retry and concurrent-delivery tests against a durable ledger; and an end-to-end test proving one input produces at most one send.

**Confidence:** 1.00

---

### 12. Medium — “Follow up later” sends a promise but records no follow-up

**File and line:** [src/templates/registry.ts:114](../src/templates/registry.ts#L114), [src/core/pipeline.ts:41](../src/core/pipeline.ts#L41)

**What can go wrong:** The bot tells a prospect, “I will make a note to follow up,” but no task, schedule, CRM record, or deferred event is created.

**Why the code allows it:** `not_now_follow_up_later` renders a reply, but the only pipeline side effects are unsubscribe and Discord notification. There is no scheduling integration.

**Likely impact:** The prospect receives a misleading commitment and the lead silently falls through the cracks.

**Concrete fix:** Either create a durable scheduled follow-up before sending the confirmation or change this intent to alert-only. Do not send the promise unless schedule creation succeeds.

**Confidence:** 1.00

---

### 13. Medium — Sensitive prospect content is sent unredacted to two third parties

**File and line:** [src/classify/openai.ts:77](../src/classify/openai.ts#L77), [src/integrations/discord.ts:36](../src/integrations/discord.ts#L36), [src/integrations/discord.ts:43](../src/integrations/discord.ts#L43)

**What can go wrong:** Email addresses, names, company details, reply bodies, and potentially confidential information are transmitted to OpenAI and Discord.

**Why the code allows it:** Full identifying fields are included in the classification prompt and Discord embed. The `sensitive_info` flag is determined only after the content has already been sent to the model, and flagged content is still posted to Discord.

**Likely impact:** Contractual, privacy, retention, and internal-access exposure—especially if prospects reply with credentials, personal data, or confidential commercial information.

**Concrete fix:** Minimize classifier inputs, redact common secrets and sensitive identifiers before external transmission, use approved retention settings, and route sensitive messages to a controlled system rather than a broad Discord channel.

**Confidence:** 0.99

## Verification notes

- TypeScript type-checking completed successfully.
- Vitest could not start in this restricted review environment because its build process attempted to read a denied parent directory. I therefore did not claim the current tests pass.
- Test coverage findings were verified statically from every test file and its imports.
- The Fastify query-secret logging behavior was reproduced locally with a fake credential.
- The working tree remained clean; no repository files were modified.

---

## My decisions (Raz Sela, 2026-09-26)

Codex was told to assume auto-send is on. It isn't: production is switched off, and this public version never sends email. Drafts go to Discord and a person sends them. So for each finding I asked two questions: is it wrong today, in the version that never sends? And does it have to be solved before auto-send comes back? Most of what was wrong today I fixed; finding 5 is the exception, and its entry says why. What only matters once the bot sends, I deferred, and each item is written down as a hard requirement in the README section [Before you turn auto-send back on](../README.md#before-you-turn-auto-send-back-on), so it isn't forgotten.

### Finding 1 (Critical): the production auto-send path is not in the reviewed source

**Decision:** Deferred until auto-send.

**Why:** Codex is right, and this finding frames the rest. Production ran on my Mac with a `sendReply` call wired into the draft branch, and that version was never committed here, so the code that actually emailed prospects was never reviewed or tested in CI. Production is off now and this version never sends, so no unreviewed send path is running today. What I won't do again is run a send path that isn't in version control.

**How:** No code change. It is the first item on the README checklist: the auto-send code in version control, behind a per-client `AUTO_SEND` flag that defaults to off. The module comment in `src/integrations/instantly.ts` no longer calls auto-send "a one-line change in the pipeline".

**Commit:** `c959b8e`

### Finding 2 (Critical): the webhook secret leaks into request logs

**Decision:** Fixed.

**Why:** Codex reproduced it and so did I. Fastify logs the full request URL, and DEPLOY.md told people to put the secret in the URL. I kept accepting `?secret=` instead of going header-only. DEPLOY.md said Instantly's webhook form couldn't send custom headers, so there may be setups that depend on the query form, and the leak itself can be closed without breaking them. When I checked for this review, though, Instantly's help center lists an optional headers field on its webhook form, so DEPLOY.md now recommends the `X-Webhook-Secret` header and keeps `?secret=` as the fallback. The query form still has a cost the server can't remove: a proxy or host in front of it may log full URLs. That is why the docs prefer the header and say to rotate any secret that was ever sent in a URL.

**How:** In `src/server.ts`, a custom `req` serializer masks the `secret=` value in the logged URL. Every log line is also masked on its way to the output stream, because Fastify writes some lines itself without the serializer: an unknown route logs `Route POST:<full url> not found` as plain text. The configured secret is masked wherever it appears, and a wrong secret is masked too. `buildServer` takes an optional log stream so tests can read what was logged. The tests in `test/server.test.ts` ("webhook secret stays out of the logs") inject requests with the right secret, a wrong one, a URL with no slug (the 404 line), and a header, then check that the value appears in no log line while the masked URL does, so the check is not vacuous. With the masking turned off, the three query-string tests fail.

**Commit:** `54fc1ae`

### Finding 3 (Critical): a leaked credential permits forged events across all clients

**Decision:** Partly fixed.

**Why:** Two of Codex's reasons were cheap to fix and apply today, auto-send or not. `event_type` was never checked, so a webhook set to "All Events" would push opens, clicks and sends through the reply pipeline as if they were replies. And `/health` is public and listed every client slug, and a slug is half of a webhook URL. The rest (a secret per client, signature verification, rate limiting) guards against forged events causing sends. With nothing sent, the worst a forged event can do today is post a fake reply to Discord, where a person reads it, or add one address to a block list. Those protections have to exist before a forged event could send an email, and they are on the checklist.

I did not make `event_type` required. Instantly's docs list it among the fields always present, but the schema here never required it, and I don't have a saved real payload to prove every one carries it. So a payload without it is still processed, with a warning in the log. Once real traffic shows no warnings, it can become required.

**How:** In `src/server.ts`, a payload whose `event_type` is present and is not `reply_received` gets `202 {"status": "ignored"}` and is never processed; a missing `event_type` logs a warning and carries on. `/health` returns `clientCount` instead of the slugs, and DEPLOY.md's verify step shows the new output. Tests in `test/server.test.ts`: four non-reply event types are acknowledged and never reach the pipeline; a payload with no `event_type` is processed and the warning is logged; `/health` gives the count and no slug. Per-client secrets, signature verification and rate limiting are one line on the README checklist.

**Commits:** `b3f00a2` (fix), `c959b8e` (checklist)

### Finding 4 (Critical): duplicate sends are not durably prevented

**Decision:** Deferred until auto-send.

**Why:** Everything Codex lists is true of the in-memory dedupe: a restart forgets it, two instances don't share it, keys expire after six hours, and a changed timestamp gives a new key. While nothing is sent, a missed duplicate costs one repeated Discord post, which is what the comment in `dedupe.ts` said. Codex's sharper point is that the comment stops being true the day auto-send is on, and then a missed duplicate is a second email to a prospect. A durable ledger with idempotency keys and timeout reconciliation is real infrastructure (a database, send states, a way to ask Instantly what happened). Building it for a bot that sends nothing would protect no one yet.

**How:** No code change to the dedupe. The README checklist requires an idempotency key on every send and any ambiguous timeout reconciled with Instantly before a retry, with the durable ledger itself under finding 5. The comment in `src/core/dedupe.ts` and the duplicates note in DEPLOY.md now say the "repeated Discord post" worst case holds only while nothing sends email.

**Commit:** `c959b8e`

### Finding 5 (Critical): the endpoint acknowledges work before it is durable

**Decision:** Deferred until auto-send.

**Why:** This one is true today, not only for sends: a crash or redeploy between the `202` and the end of processing loses the reply, opt-outs included. DEPLOY.md already called it a known limit, but said the fix was "sketched in the repo issues", and the repo has no issues, so that pointer led nowhere. My reasoning for deferring: the public version is draft-only and low volume, and a pipeline error after the ack already posts a Discord alert telling a person to handle the reply in the Unibox. What is left is a crash inside that gap, which is rare. A durable queue is the right fix, and I would rather build it once, together with the send ledger, than twice. Codex's second point, that the dedupe key is recorded before processing so a retry after a failure is dropped as a duplicate, is also true; the failure alert covers it for now, and the same ledger fixes it.

**How:** No code change. The README checklist requires a durable event ledger keyed by a stable provider event ID, written before the `202` goes back. DEPLOY.md's known-limit note now points to that checklist instead of to issues that don't exist.

**Commit:** `c959b8e`

### Finding 6 (Critical): no suppression check immediately before sending

**Decision:** Deferred until auto-send.

**Why:** There is no send, so there is no send boundary to check. When there is one, it needs its own append-only suppression record, checked right before the call and failing closed, because the classification of the current reply says nothing about an opt-out that arrived a minute earlier on another thread. Today, opt-outs go to the workspace block list, which is what keeps Instantly's own sequences from emailing those people again.

**How:** No code change. The README checklist requires an append-only suppression check at the send boundary that fails closed: if the check can't run, nothing is sent. Findings 7 and 8 below make opt-outs harder to miss before they ever reach that boundary.

**Commit:** `c959b8e`

### Finding 7 (High): failed or impossible opt-outs can stay silent and be logged as successful

**Decision:** Fixed.

**Why:** This is the one I most wanted fixed, because it is wrong today with auto-send off. An opt-out the bot fails to apply leaves someone mailable who asked not to be, and the log said `"unsubscribed": true` whatever happened. A skipped unsubscribe (no lead email in the payload, or no API key for that workspace) only reached `console.warn`, which nobody reads in time, and the result of the Discord warning for a failed one was never checked. I did not build Codex's full version (durable work items, an independent paging channel, blocking future sends on unresolved opt-outs); those belong with the ledger. What matters now is that the log tells the truth and a person hears about every opt-out that didn't go through.

**How:** In `src/core/pipeline.ts`, the summary log line records the actual outcome (`unsubscribe`: `done`, `skipped`, `failed` or `not_requested`, with the reason) next to `unsubscribeRequested`, the decision flag. Both `failed` and `skipped` post a Discord alert asking for a manual block, with the Unibox link when the payload has one. If that alert can't be posted, the pipeline logs an error naming the lead as still not unsubscribed. `processWebhook` returns the outcome. Tests in `test/pipeline.test.ts`, with Instantly and Discord mocked and `fetch` stubbed to throw: `done` posts nothing extra; `failed`, `skipped` for a missing key, and `skipped` for a missing email each post an alert and log the true outcome; a failed alert logs an error. All five fail against the old pipeline. `test/instantly.test.ts` checks that the real `markLeadUnsubscribed` returns `skipped`, `done` and `failed` in the right cases.

**Commits:** `760dfd9`, with the `markLeadUnsubscribed` tests in `06c2b13`

### Finding 8 (High): untrusted model output is used as send authorization

**Decision:** Partly fixed.

**Why:** Codex's example is exactly the gap. "Please stop contacting our company" matched none of the exact phrases in `rules.ts`, so it depended on the model, and a confident wrong "interested" would have been drafted. An opt-out is the one thing I never want to depend on the model. The new check is deliberately broad: a false match costs one Discord alert, a miss costs a sales email to someone who asked to be left alone. It never unsubscribes on a pattern alone, because not every match is an opt-out ("don't email me, call me instead" matches), so a person decides. One side effect I accepted: an auto-reply whose own footer says "unsubscribe" now reaches Discord instead of being dropped. I would rather see that noise than miss a real opt-out.

What I did not do: other languages, detectors for threats, legal wording or prompt injection, and a labeled adversarial set to calibrate the model. While a person reads every draft before it goes, the model's output is already evidence rather than authorization. Those become necessary before auto-send; the deterministic opt-out layer is the part that had to exist either way.

**How:** In `src/core/decide.ts`, `findOptOutLanguage` checks the reply text (after quoted history is stripped) for "stop contacting / emailing / reaching out", "remove me / us", "unsubscribe", "do not contact / email", "take me / us off" and "opt out": English, case-insensitive, on word boundaries. It runs first in `decide()`. If it matches and the model did not also call the reply an opt-out, the decision is an alert with the reason "Opt-out language detected", whatever the intent or confidence. That includes out-of-office readings, which used to be dropped silently. When the model does read the reply as `unsubscribe` or `not_interested`, the existing path is unchanged. Tests in `test/decide.test.ts`: "Please stop contacting our company" with a 0.99 "interested" classification alerts without unsubscribing; eight wording variants never draft; an out-of-office reading with an opt-out alerts; the model-read path is unchanged; a normal positive reply still drafts; "adopted" does not match "opt". `test/pipeline.test.ts` runs the same case through `processWebhook` with a stubbed model. Twelve of these fail against the old `decide()`.

**Commit:** `5d43991`

### Finding 9 (High): send-critical payload fields are optional and loosely bound

**Decision:** Deferred until auto-send.

**Why:** The loose schema is on purpose for a bot that only drafts. `types.ts` notes that Instantly's field names have drifted between campaign versions, and a reply with a missing field should still reach a person rather than bounce with a `400`. For a send, the opposite is right: every field present, and the campaign and sending account checked against the client. That is a separate, stricter schema at the send step, not a tighter webhook schema.

**How:** No code change. The README checklist requires a strict schema for the fields a send needs, with the campaign and sending account bound to the client.

**Commit:** `c959b8e`

### Finding 10 (High): no kill switch, volume cap, or circuit breaker

**Decision:** Deferred until auto-send.

**Why:** All of these limit how many emails go out, and today none do. Discord posts are bounded by the replies that come in.

**How:** No code change. The README checklist requires per-client and global send caps, a small canary quota, and a kill switch that works without a redeploy, on top of the default-off per-client flag from finding 1.

**Commit:** `c959b8e`

### Finding 11 (High): the webhook, unsubscribe and send paths have no tests

**Decision:** Fixed for everything that exists today. The at-most-one-send test is deferred until auto-send, because nothing sends yet.

**Why:** Codex's point was fair. The four test files covered the pure parts, and the code that touches the outside world had no test at all. The README said the suite covered "the full routing matrix", which was true of `decide()` and nothing else. Tests at that boundary are what stop a refactor from quietly breaking auth or opt-outs.

**How:** `test/server.test.ts` drives `buildServer` through Fastify's `inject`: `401` with no secret and with a wrong one, `400` for a malformed payload, `202` accepted with the right client, `202` duplicate processed only once, an unknown slug passed on with no client, and a pipeline error raising a Discord alert, plus the log, event-type and `/health` tests from findings 2 and 3. `test/pipeline.test.ts` runs `processWebhook` with Instantly and Discord mocked and `fetch` stubbed to throw: the draft path posts to Discord and never calls `sendReply`, an ignored out-of-office posts nothing, an unknown slug never calls Instantly, and a model failure alerts as "unclear". An `afterEach` there asserts `sendReply` was never called in any test in the file. `test/instantly.test.ts` checks the real block-list request and how each response is read, `test/openai.test.ts` what goes to OpenAI and how its answer is parsed, and `test/discord.test.ts` the embed and a failed post. The README's testing section now says what is covered and what is not. No test calls a real service.

**Commits:** `06c2b13`, with more tests in `54fc1ae`, `b3f00a2`, `760dfd9`, `5d43991`, `df89a58` and `ac79b22`

### Finding 12 (Medium): "follow up later" sends a promise but records no follow-up

**Decision:** Fixed.

**Why:** The template says "I will make a note to follow up with you in Q4", and nothing makes that note. Even with a person approving each draft, that promise is easy to send and forget. Codex offered two fixes: create the scheduled follow-up first, or make the intent alert-only. Scheduling needs a calendar or CRM integration this bot doesn't have. Alert-only keeps the text useful and puts the reminder with the person who sends it.

**How:** In `src/core/decide.ts`, `not_now_follow_up_later` routes to an alert after all the usual guards, so a flag or a long reply still alerts with its own reason. The rendered template, timeframe included, travels as a new `Decision.suggestedReply`. It is kept apart from `draft` on purpose, so nothing that acts on drafts can pick it up. The Discord embed in `src/integrations/discord.ts` shows "Action needed" and the suggested reply, and `scripts/replay.ts` prints it. Tests: the `decide()` timeframe tests now check the suggested reply (the Q4 phrase and the soft fallback) and that no draft is set; `test/discord.test.ts` reads the embed through a stubbed `fetch`.

**Commit:** `ac79b22`

### Finding 13 (Medium): sensitive prospect content goes unredacted to two third parties

**Decision:** Partly fixed.

**Why:** OpenAI was getting more than it needed. The system prompt judges the person's own words and never uses the lead's name, email address or company, or the campaign name, so sending them bought nothing. Discord is different. It is where a person reads the reply and answers it, and they need to know who wrote it, at which company, and what they said. Stripping that would make the alerts useless, so Discord keeps full details, and the README says to keep those channels to the people who handle replies. I did not add secret redaction inside reply bodies or a separate route for `sensitive_info` replies; that flag already forces an alert instead of a draft.

**How:** `src/classify/openai.ts` now sends the subject and the reply body only. The body still goes as written after quote stripping, so a signature inside it can carry a name or phone number; cutting signatures reliably would also cut words the classifier needs. `test/openai.test.ts` captures the messages through `setOpenAIClientForTesting` and checks that the lead's name, email, company, phone and campaign appear nowhere in them; it fails against the old prompt. The README has a new "What leaves the server" section covering OpenAI, Discord and Instantly.

**Commit:** `df89a58`

### What the review caught that I had missed

Three of the findings were live in the version that never sends, not only under auto-send: the secret written to the logs, an opt-out that failed or was skipped while the log said it had worked, and opt-out wording that only the model was reading. I had also left "the worst case is a repeated Discord post" in comments and docs that would stop being true the day auto-send came back, and DEPLOY.md pointed at repo issues that don't exist. The tests went from 59 in 4 files to 115 in 9 files, and the new ones sit at the boundary Codex said had none.

## Verification

Codex ran the TypeScript check, which passed. It could not start vitest in its sandbox (the build step tried to read a parent directory the sandbox denied), so it did not claim the tests pass, and it checked test coverage by reading the test files.

My run, on the commit that adds this record, on Windows 11 with Node 24.19.0: `npm run typecheck` passed, and `npx vitest run` passed 115 tests in 9 files. Before the fixes, at `eb16c28`, the same command passed 59 tests in 4 files. CI runs the same two commands on Node 20.
