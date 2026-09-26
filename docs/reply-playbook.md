# Reply Bot — What Happens to Every Reply

Every reply to a campaign lands in one of **three buckets**. Nothing is ever sent automatically — when the bot writes a reply, it posts the draft to Discord and a human approves it before it goes out.

| Bucket | What it means |
| --- | --- |
| 🚫 **Ignored** | No reply sent, nothing posted. Opt-outs are also automatically unsubscribed in Instantly so they never get another email. |
| ✍️ **Auto-draft** | The bot writes the reply below and posts it to Discord, ready to approve and send. |
| 🔔 **Human alert** | No auto-reply. The full message is posted to Discord with why it needs a person. |

Anything in the template text like `[calendar link]` or `[what we do]` is filled in per client — each client has their own calendar, pitch, and pricing wording.

---

## 🚫 Bucket 1 — Ignored (no reply, auto-unsubscribed)

Short, bare rejections with nothing else in them. Replying to these has no upside, so the bot stays silent — but it **does** add the person to that client's Instantly block list immediately, so no follow-up emails ever go out.

Triggers (sign-offs like "…thanks, John" are fine — still counts):

- "No" / "Nope"
- "Not interested"
- "No thanks"
- "Unsubscribe"
- "Stop" / "Stop emailing me"
- "Remove me" / "Take me off your list"
- "Opt out"
- "Do not contact me"
- "Delete my info"

Also ignored (but **not** unsubscribed — they may still convert later):

- Out-of-office auto-replies
- Automated mail — bounces, ticket confirmations, delivery notices

**Important:** a rejection with *anything extra* in it — a reason, a complaint, anger — is NOT ignored. It goes to Bucket 3 so a human sees it (and opt-outs still get unsubscribed on top).

---

## ✍️ Bucket 2 — Auto-drafted replies

### 1. Interested / wants to talk
**They say:** "Yes let's chat" · "Sounds interesting" · "Sure" · "When are you free?" · "Tell me more" · "Book me in"

> Great, really glad this resonated.
>
> Here is a link to grab a time that works for you: `[calendar link]`
>
> Looking forward to it.
>
> Best,
> `[sender name]`

### 2. "What exactly do you do?"
**They say:** "How does this work?" · "What is this about?" · "Can you elaborate?" · "Who are you?"

> Of course, happy to explain.
>
> `[1–3 sentence description of what the client does]`
>
> The easiest way to see if there is a fit is a quick call. Here is my calendar if you want to grab a time: `[calendar link]`
>
> No commitment, just a conversation.
>
> Best,
> `[sender name]`

### 3. Pricing questions
**They say:** "How much does this cost?" · "What are your rates?" · "Is there a fee?" · "How does payment work?"

> Good question, happy to share.
>
> `[the client's pricing explanation]`
>
> Happy to walk you through the full structure on a call if that helps. Here is my calendar: `[calendar link]`
>
> Best,
> `[sender name]`

### 4. Case studies / proof
**They say:** "Do you have case studies?" · "Who else have you worked with?" · "Show me results" · "Prove it works"

> Absolutely, happy to share.
>
> The best way to do that is on a quick call where I can walk you through some specific examples relevant to your industry.
>
> Here is my calendar: `[calendar link]`
>
> Alternatively I can send over a brief overview by email if you would prefer. Just let me know which works better.
>
> Best,
> `[sender name]`

### 5. "We already have someone for this" *(only if no competitor is named)*
**They say:** "We already have an agency" · "We handle this internally" · "We tried something similar before"

> That is completely fair and actually pretty common.
>
> `[the client's differentiator — what makes them different]`
>
> If you ever feel like your current setup is not hitting the numbers you need, happy to show you how we approach it differently. Here is my calendar if that conversation ever makes sense: `[calendar link]`
>
> No pressure either way.
>
> Best,
> `[sender name]`

⚠️ If they name a specific competitor ("We use Belay"), this does **not** auto-send — it goes to a human (Bucket 3), because a tailored comparison beats a canned one.

### 6. "Reach out later"
**They say:** "Try me in Q4" · "Check back in January" · "We're too busy right now" · "Ask me again in a few weeks"

The bot picks up the actual timeframe they gave and echoes it back:

> Completely understand, timing is everything.
>
> I will make a note to follow up with you **in Q4** *(their words — falls back to "a little further down the line" if they gave no date)*. In the meantime feel free to reach out if anything changes sooner.
>
> Best,
> `[sender name]`

### 7. "How did you get my email?"
**They say:** "Where did you find me?" · "How did you get my contact details?" · a simple "Is this GDPR compliant?"

> Your details are publicly available through professional business directories and LinkedIn. We research companies that match the profile of businesses we typically work with and reach out directly.
>
> Happy to answer any other questions — or if you would prefer not to hear from us, just let me know and I will remove you straight away.
>
> Best,
> `[sender name]`

### 8. "I'm not the right person" *(and they don't say who is)*
**They say:** "This isn't my department" · "Not my call"

> Apologies for the misfire, and thanks for letting me know.
>
> Is there someone at `[their company]` who would be the right person for this? Happy to reach out to them directly so this stops landing in your inbox.
>
> Best,
> `[sender name]`

---

## 🔔 Bucket 3 — Human alert (no auto-reply, posted to Discord)

The bot never auto-replies to any of these. The full message, who sent it, and the reason land in the client's Discord channel.

**Hard rules — counted automatically, no AI judgment involved:**

- Reply is **longer than 150 words** (or 900 characters)
- Reply asks **more than 2 questions**
- Reply contains **opt-out wording** ("stop contacting", "remove me", "unsubscribe", "take me off", "opt out") that the AI did not read as an opt-out. A person checks it and unsubscribes them if they meant it.

**Content that always gets a human:**

- **Angry or emotional rejections** — "Remove me, this is the third time you've emailed me." (Still auto-unsubscribed, but a person sees it.)
- **Objections with a reason** — "No budget this year", "Bad experience with outbound before"
- **A specific competitor named** — "We already use Belkins"
- **Referrals, both directions** — "Talk to our office manager Sarah" (a warm handoff deserves a personal reply, not a template) and "John from Acme mentioned you guys" (that's a warm lead)
- **Existing relationship** — "Didn't we speak last year?"
- **Legal / contract territory** — lawyers, formal compliance demands, contract questions (a simple "is this GDPR compliant?" gets the sourcing reply above; anything heavier goes to a human)
- **Negotiation** — they bring up specific numbers, terms, or contract lengths
- **Deep technical questions** — detailed "how exactly does your process work" digs
- **Press / media** — journalists, articles, podcasts
- **They share sensitive info** — confidential business or personal details

**Safety-net cases — anything the system can't handle confidently:**

- The AI is **less than 70% sure** what the reply means
- The reply is **ambiguous or garbled**
- A positive reply that **no template covers**
- The client's profile is **missing the needed text** (e.g. no pricing info configured → pricing questions go to a human instead of a broken draft)
- A reply arrives on an **unconfigured webhook** (never drafts with the wrong client's calendar)
- The **AI service is down** — every reply during an outage becomes an alert; nothing is ever lost or guessed

---

## The one automatic action

The only thing the bot ever does without approval: when someone opts out or declines, their email is added to that client's Instantly block list so they never get emailed again. If that can't be done (the API call fails, or the workspace has no API key set up), a warning posts to Discord asking for a manual unsubscribe. Everything outbound, every reply, is human-approved.
