# ep-lead-intake: how to use it

ep-lead-intake reads inquiry emails sent to one mailbox and creates the matching lead in the EP CRM. If it can't create a lead safely, it forwards the mail to the lead generator. If the service itself breaks, it emails an alert.

- [1. Day-to-day use](#1-day-to-day-use)
- [2. What happens to a mail](#2-what-happens-to-a-mail)
- [3. Setup](#3-setup)
- [4. Configuration reference](#4-configuration-reference)
- [5. AI models](#5-ai-models)
- [6. Queue and retries](#6-queue-and-retries)
- [7. Error alerts](#7-error-alerts)
- [8. Going live](#8-going-live)
- [9. Troubleshooting](#9-troubleshooting)
- [10. Logs in Grafana](#10-logs-in-grafana)

---

## 1. Day-to-day use

**Who sends:** only the addresses in `ALLOWED_SENDERS` (for example the co-founder).

**What to send:** forward the client's inquiry to the intake mailbox (`INTAKE_MAILBOX`), or Cc the mailbox on your reply. On top of the forward, write who should handle it.

### Example

```
To:      leads@excellentpublicity.com
Subject: Fwd: Radio campaign for Diwali

Priya to handle.

---------- Forwarded message ---------
From: Anita Rao <anita.rao@sunrisefoods.in>
Date: Mon, 26 Oct 2026 at 11:02
Subject: Radio campaign for Diwali

Hi, we are Sunrise Foods Pvt Ltd, Pune. We'd like to run a radio campaign
across Maharashtra in the first two weeks of November. Budget around 5 lakhs.
You can reach me at +91 98765 43210.

Anita Rao, Marketing Manager
```

Within a few seconds the lead is created in the CRM, and the mail gets the `CRM-Done` label. The service sends no confirmation mail; the CRM notifies the assigned salespeople itself. The lead created:

```json
{
  "companyName": "Sunrise Foods Pvt Ltd",
  "mobile": "9876543210",
  "mobileCountryCode": "+91",
  "contactName": "Anita Rao",
  "designation": "Marketing Manager",
  "city": "Pune",
  "budget": "5 lakhs",
  "notes": "Radio campaign across Maharashtra, first two weeks of November (Diwali).",
  "source": "Email marketing",
  "services": ["Radio"],
  "salesPersonEmails": ["priya@excellentpublicity.com"]
}
```

The CRM notifies Priya through the bell and by email.

### Rules for senders

| Do | Why |
|---|---|
| Put the salespeople who should own the lead in **To:** | Every To: recipient who is a CRM user is assigned (the sender, the intake mailbox and the lead generator are skipped). Cc never assigns |
| If nobody suitable is in To:, name the owner in the text: "Priya to handle", "@Ravi" | The AI maps the name to a CRM user; without any owner the mail goes to review |
| Use a name that matches only one CRM user (use the full name if two share a first name) | Ambiguous names are sent to review |
| Make sure the client's email or phone number is in the mail | The service never guesses contact details |
| Send one client per mail | A mail about several companies is sent to review |

When something is missing, the lead generator (`LEAD_GENERATOR_EMAIL`) receives the original mail with the reason and the AI's draft at the top, and adds the lead by hand. Nothing is ever dropped silently.

The service sends mail in exactly two cases: this review forward, and error alerts to `ALERT_EMAIL` (§7). It never replies to the sender.

---

## 2. What happens to a mail

```
sender ──▶ INTAKE_MAILBOX ──Gmail filter──▶ label "Lead-Intake"
                                              │
             Gmail push (seconds) or sweep every SWEEP_INTERVAL_MINUTES
                                              ▼
                                    queue (oldest first, one at a time)
                                              ▼
  allowlist + sender authentication ─▶ AI drafts lead ─▶ checks in code ─▶ CRM create
```

Each mail ends with one Gmail label. The labels are the record of what happened; there is no database.

| Label | Meaning | Who is told |
|---|---|---|
| `CRM-Done` | Lead created | Nobody by this service; the CRM notifies the assigned salespeople |
| `CRM-Review` | Lead not created (missing details, ambiguous owner, duplicate lead, CRM refused it) | Lead generator gets the forward with the reason |
| `CRM-Ignored` | Sender isn't allowed, or the mail failed authentication (DMARC/SPF/DKIM) | Nobody |
| *(no label yet)* | Not processed yet, or failed on our side (AI down, CRM down) and waiting for a retry | `ALERT_EMAIL`, if it's an error |

To have a mail processed again, remove its `CRM-…` label in Gmail. The next sweep picks it up.

**New CRM users and services.** The CRM's user and service lists are cached for 5 minutes. A salesperson or service added in the CRM inside that window still works: when a mail mentions one the cached list doesn't know, the service fetches the lists again before deciding. Only if the fresh lists don't have it either does the mail go to review.

**Checks the AI can't bypass.** Whatever the AI returns, the code refuses the lead unless:
- the client email or phone number literally appears in the mail;
- the contact isn't one of your own company's addresses;
- every salesperson is a user in the CRM;
- every service is in the CRM's service list.

---

## 3. Setup

Do this once. You need admin access to Google Workspace, a Google Cloud project, an OpenRouter account and Railway.

1. **Mailbox.** Pick the intake address, for example `leads@yourdomain.com`, and create it in Google Workspace. Put it in `INTAKE_MAILBOX`. Any address works; nothing else is hard-coded.
2. **Gmail filter.** In that mailbox: *Settings → Filters → Create filter*, set **From** to the allowed senders (`a@x.com OR b@x.com`), then choose *Apply the label* `Lead-Intake` (create the label if it doesn't exist). The service creates `CRM-Done`, `CRM-Review` and `CRM-Ignored` itself.
3. **Google Cloud.**
   1. Enable the **Gmail API** and **Cloud Pub/Sub API**.
   2. Pub/Sub → create topic `gmail-leads`. In the topic's permissions, grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role.
   3. IAM → create a service account, for example `gmail-push`.
   4. Pub/Sub → create a subscription on the topic: delivery type **Push**, endpoint `https://<your-railway-domain>/gmail/push`, **Enable authentication** with that service account, audience equal to the endpoint URL, ack deadline 30 s.
   5. OAuth consent screen: **Internal**. Credentials → create an OAuth client ID of type **Desktop app**.
4. **Refresh token.** On your machine: `cp example.env .env`, fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `INTAKE_MAILBOX`, then run:
   ```
   npm install
   npm run authorize
   ```
   Open the printed URL, sign in **as the intake mailbox**, and copy the printed `GMAIL_REFRESH_TOKEN=…` line into `.env`.
5. **AI keys.** Create a Groq key at console.groq.com/keys and/or an OpenRouter key at openrouter.ai/keys. For OpenRouter: If you use free models, go to *Settings → Privacy* and allow free-model data use; otherwise free models return "No endpoints found matching your data policy".
6. **Railway.** Create a service from this repo with build command `npm run build`, start command `npm start`, **1 replica**, and a public domain. Paste every variable from your `.env` into *Variables* (leave out `PORT`). Start with `DRY_RUN=true`.

At startup the service checks that the Gmail token belongs to `INTAKE_MAILBOX` and creates any missing labels. It then starts watching the `Lead-Intake` label and runs a first sweep. `GET /health` returns `{"ok":true,"queue":{…}}`.

---

## 4. Configuration reference

All variables are in [example.env](../example.env), with comments.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | | `3000` | HTTP port (Railway sets it) |
| `LOG_LEVEL` | | `info` | Log verbosity |
| `INTAKE_MAILBOX` | ✓ | | Address that receives inquiries; must match the Gmail token |
| `COMPANY_NAME` | | `Excellent Publicity` | Your company, so the AI never treats it as the client |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | ✓ | | Desktop OAuth client |
| `GMAIL_REFRESH_TOKEN` | ✓ | | From `npm run authorize` |
| `GMAIL_INTAKE_LABEL` | | `Lead-Intake` | Label set by the Gmail filter |
| `GMAIL_PUBSUB_TOPIC` | ✓ | | `projects/<project>/topics/<topic>` |
| `PUBSUB_AUDIENCE` | ✓ | | Push endpoint URL |
| `PUBSUB_SERVICE_ACCOUNT` | ✓ | | Push subscription's service account email |
| `GROQ_API_KEY`, `GROQ_MODELS` | one provider ✓ | | Groq key and comma-separated model ids; tried first |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODELS` | one provider ✓ | | OpenRouter key and model ids; used when Groq is exhausted |
| `AI_ROTATION` | | `round-robin` | `round-robin` or `fallback` (§5) |
| `AI_COOLDOWN_SECONDS` | | `60` | How long a failed model is skipped |
| `CRM_URL`, `LEAD_IMPORT_API_KEY` | ✓ | | CRM address and import key |
| `INTERNAL_DOMAINS` | | | Optional. Extra domains that are always ours. Usually left empty: see §5, "Who is us" |
| `ALLOWED_SENDERS` | ✓ | | Comma-separated senders allowed to submit inquiries |
| `LEAD_GENERATOR_EMAIL` | ✓ | | Receives mail that needs a human |
| `ALERT_EMAIL` | ✓ | | Comma-separated addresses for error alerts |
| `ALERT_THROTTLE_MINUTES` | | `60` | Minimum gap between two alerts for the same error |
| `SWEEP_INTERVAL_MINUTES` | | `10` | How often the mailbox is searched for unprocessed mail |
| `DRY_RUN` | | `false` | `true`: no CRM call, labels, replies or forwards |
| `DEBUG_DUMP` | | `false` | `true`: prints each Pub/Sub push to the console and writes each fetched mail to `<temp>/ep-lead-intake/<gmail-id>.txt` (§8) |

---

## 5. AI models

The AI only reads the mail and drafts the lead. It can't create anything on its own, and every draft goes through the code checks in §2.

**The prompt is a file.** The AI's instructions are in [prompts/system.md](../prompts/system.md). It describes how a SmartLead reply thread looks, who is the client and who is us, where each field is found, what to ignore (our pitch prices, the cross-sell list, our phone numbers, Meet dial-ins), a services vocabulary (railway → Transit, cricket → Sports Marketing, …) and the only reasons a mail may go to review. Edit it as you learn, then restart the service. `{{COMPANY_NAME}}` is filled in from the env.

**What the code does before and after the AI**, so every model gets the same help:
- **Before:** it removes duplicates and noise from the thread (repeated pitches, signatures, disclaimers, link fragments, dial-ins), usually halving it. It also adds a `<hints>` block: the outside participants (the likely client), a company guess from their domain, our phone numbers, and the client's phone lines with their labels.
- **After:** the AI may only send a mail to review when there is no client contact at all, the thread is about several companies, or the client clearly declined. A missing mobile, service, budget or city never causes a review. If an email or mobile fails the checks but the other one is fine, the bad one is dropped and noted. Unknown services go to notes. If every model returns unusable output, a minimal lead is built from the hints, with a note to complete it.

**Who is us, without a domain list.** The outreach team writes from many, changing domains, so nothing has to be listed. The code splits each thread into its messages and decides who wrote each one. An author counts as ours when:
- their domain is already known: a CRM user's domain, the sender's, or the intake mailbox's;
- their domain contains the company name (`excellentpublicityooh.com`, `…connect.com`, `…ind.in`, …); or
- their own message carries our signature line ("Excellent Publicity"), our footer ("Feel free to contact us…", "Member of BNI"), our signature image, or reads like our sales pitch.

Their domain is then treated as ours for that thread, and every phone number in their messages counts as ours. Anyone else who wrote in the thread is a client candidate. If one domain is ever misjudged, add it to `INTERNAL_DOMAINS`.

**Prompt caching.** The system prompt and the services list are identical for every mail and come first in each request, so a provider that caches prompts can reuse them (on Groq, cached input is 50% cheaper and doesn't count toward the per-minute limit). Nothing has to be switched on; check `tokens.cached` in the `AI answered` log line. In testing, Groq's `qwen/qwen3.8-27b` and `openai/gpt-oss-120b` served nothing from cache.

**Testing prompt changes:** save DEBUG_DUMP files of real threads in `examples/`, add the expected result to `examples/expected.json`, and run `npm run try-examples`. It replays every thread through the real AI and the checks, and prints PASS/FAIL per thread. It doesn't call the CRM, send mail or send alerts.

**Two providers, Groq first.** The service uses Groq and OpenRouter, both through the same OpenAI-style chat API (no SDK). For each mail it tries:

1. every Groq model in `GROQ_MODELS`;
2. if all of them are rate-limited or failing, every OpenRouter model in `OPENROUTER_MODELS`.

Either provider can be left out by leaving its `…_MODELS` empty, but at least one must be set.

**Choosing models.**
- **Groq:** pick ids from [console.groq.com/docs/models](https://console.groq.com/docs/models), for example a Qwen model.
- **OpenRouter:** free models must support **structured outputs**. To list them:

```
curl -s https://openrouter.ai/api/v1/models   | jq -r '.data[] | select(.id|endswith(":free")) | select(.supported_parameters|index("structured_outputs")) | .id'
```

`openrouter/free` lets OpenRouter pick a free model, which makes it a good last entry. Free models are added and removed often, so check the list every few weeks.

**JSON format.** The service first asks each model for strict JSON-schema output. If a model replies that it doesn't support that, the service asks again in plain JSON mode with the schema written into the prompt, and remembers that model's answer until restart. Either way the code checks the answer against the expected format, and ignores `<think>` blocks and extra text around the JSON.

**How rotation works** (`AI_ROTATION`, applied within each provider; Groq always comes before OpenRouter):

| Mode | Which model a mail starts with | When a model fails |
|---|---|---|
| `round-robin` (default) | Mail 1 starts with Groq model A, mail 2 with Groq model B, … | Remaining Groq models, then OpenRouter models |
| `fallback` | Always Groq model A | Groq B, C, …, then OpenRouter models |

A model that returns an error is skipped for `AI_COOLDOWN_SECONDS` (or for as long as the provider's `Retry-After` header says). A model that returns unusable output (not JSON, wrong format) isn't benched, but the next model is tried. If every model returns unusable output, the mail goes to review. If every model errors or is benched, the mail stays queued for the next sweep and an alert is sent.

**Free-tier limits** (approximate; providers change them often):
- **Groq:** per model and per account; roughly 30 requests per minute and about 1,000 per day for larger models. Check the limits page in the Groq console.
- **OpenRouter:** about 20 requests per minute per model, and 50 requests per day **for the whole account**, or 1,000 per day once the account has bought $10 of credits.

With both configured, mail keeps flowing until both providers' limits are used up.

**Privacy.** Free models may log or train on what you send (check each provider's data policy), and each mail you send includes client names, emails and phone numbers. If that isn't acceptable, use paid models; no code change is needed.

---

## 6. Queue and retries

- Every Gmail push and every sweep (on startup, then every `SWEEP_INTERVAL_MINUTES`) searches the mailbox for `Lead-Intake` mail without a `CRM-…` label. The results are added to an in-memory queue.
- One worker takes mail off the queue **one at a time, oldest first**. If 20 mails arrive together, they're processed in arrival order, never in parallel.
- A mail already in the queue or being processed isn't queued twice.
- If processing fails on our side (AI down, CRM down, Gmail error), the mail stays unlabelled and the next sweep queues it again. So a failing mail is retried about every `SWEEP_INTERVAL_MINUTES`.
- The queue lives in memory. Losing it on a restart is harmless, because the startup sweep rebuilds it from Gmail.
- Run **one replica only**. Two instances would process the same mail twice.

---

## 7. Error alerts

When something fails, an email goes to every address in `ALERT_EMAIL`:

| Stage | When |
|---|---|
| `AI` | Every model failed for a mail, or a model fails for any reason other than a rate limit (bad key, model removed, provider error) |
| `CRM` | CRM unreachable, `401` (bad import key) or `5xx` |
| `Gmail` | Searching or reading the mailbox failed |
| `Watch` | Renewing the Gmail watch failed; new mail then only arrives through sweeps |
| `Boot` | The service couldn't start (for example, the token is for the wrong mailbox) |
| `Processing` / `Crash` | Any other unexpected error |

Example alert:

```
Subject: [ep-lead-intake] AI failure: a mail could not be processed

ep-lead-intake hit an error on leads@excellentpublicity.com.

What failed: AI
Summary:     a mail could not be processed
Error:       Error: all AI models failed: nvidia/...:free: 429: Rate limit exceeded | ...
Gmail id:    18f3a2b4c5d6e7f8
Time:        2026-10-29T09:41:12.000Z
Dry run:     false

The mail is left unlabelled and will be retried automatically on the next sweep.
```

The same error is sent at most once per `ALERT_THROTTLE_MINUTES`; the next alert says how many repeats were held back. Plain rate limits (`429`) on a single model don't trigger an alert unless every model fails.

Alerts are sent from the intake mailbox. If Gmail itself is down, the alert can't be sent and only appears in the logs. A bad environment at startup is also log-only, because the alert address is part of that environment.

---

## 8. Going live

1. **Try single mails.** With `.env` filled in locally, run `npm run dry-run -- <gmail-message-id>`. The id is the last part of the Gmail URL when the mail is open. This prints the draft and the checks, and sends nothing. Do this for 10–20 real inquiries. If drafts are wrong, adjust the prompt in `src/extract.ts`.
   To see exactly what arrives, set `DEBUG_DUMP=true` locally. Each Pub/Sub push prints to the console with its decoded `{ emailAddress, historyId }`. Each fetched mail gets a file in your temp folder (on Windows `%TEMP%ep-lead-intake<gmail-id>.txt`), with the parsed headers and body, the sender check, the exact AI input, the AI result and the validation. The console prints the file path. These files contain client data, so keep `DEBUG_DUMP=false` in production.
2. **Dry run in production.** Deploy with `DRY_RUN=true` for a few days. Compare the `dry run: lead not created` and `mail sent to review` log lines with what the lead generator entered by hand.
3. **Switch on.** Set `DRY_RUN=false`. Mail that arrived during the dry run has no labels, so the first sweep processes it for real.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Startup fails with "GMAIL_REFRESH_TOKEN is for x, but INTAKE_MAILBOX is y" | Token created in the wrong Google account | Run `npm run authorize` again, signed in as `INTAKE_MAILBOX` |
| Startup fails with "Environment is not valid" | Missing or malformed variable | The log lists each one under `missing` and `invalid`; compare with `example.env` |
| Startup fails at "gmail sign-in as INTAKE_MAILBOX" with `invalid_grant` | Refresh token belongs to a different OAuth client, or was revoked | Run `npm run authorize` again signed in as `INTAKE_MAILBOX` |
| Every mail is labelled `CRM-Ignored` | Sender not in `ALLOWED_SENDERS`, or internal mail arriving without Gmail authentication results | Check the log reason. If it's "sender failed DMARC/SPF+DKIM" for internal mail, look at the mail's original headers and raise it with the developer |
| Nothing happens when mail arrives | Gmail filter didn't add `Lead-Intake`, or the Pub/Sub push isn't reaching the service | Check the label is on the mail; check the subscription's delivery errors. Sweeps still catch mail within `SWEEP_INTERVAL_MINUTES` |
| Push requests get `401` | `PUBSUB_AUDIENCE` or `PUBSUB_SERVICE_ACCOUNT` doesn't match the subscription | Make them identical to the subscription's settings |
| AI alerts saying "No endpoints found matching your data policy" | OpenRouter privacy setting | Allow free-model data use in OpenRouter settings, or use paid models |
| AI alerts saying a model returns `404` | Model was removed or the id is wrong | Fix it in `GROQ_MODELS` / `OPENROUTER_MODELS` |
| Lots of mail in review with "Unknown salesperson" | Names don't match CRM users | Use full names, or Cc the salesperson |
| A mail needs to be processed again | | Remove its `CRM-…` label in Gmail |

---

## 10. Logs in Grafana

Logs go to the same Grafana Loki stack as ep-crm, under their own `app` label. Set `LOKI_URL`, `LOKI_USERNAME` and `LOKI_PASSWORD` to the same values ep-crm uses. With `LOKI_URL` empty, logs go to stdout only; a wrong URL or token never stops the service. Logs always go to stdout as well.

Routine start-up and shutdown progress (`starting`, `startup: <step> ok`, `started on port …`, `gmail watch renewed`, `shutting down`) is printed to the console only and never sent to Loki; it contains no configuration values.

Labels follow ep-crm's: `app="ep-lead-intake"`, `env` (from `NODE_ENV`) and `level`. Pino's `warn` appears in Loki as `warning`, and `fatal` as `critical`. Everything else is in the JSON line. Filter on the `level` label, never on the parsed field.

| `msg` | Level | When |
|---|---|---|
| `startup: crm reference failed; continuing` | warning | CRM not reachable at startup; the service still starts and retries per mail (`hint` says what to fix) |
| `startup failed: Environment is not valid (…)` | critical | Variables missing or malformed; lists them in `missing` / `invalid`; the service exits |
| `startup failed at "<step>": …` | critical | A startup step failed; `hint` says how to fix it; the service exits and an alert is attempted |
| `mail queued` | info | Mail added to the queue |
| `crm reference refreshed` | info | The cached CRM users/services list missed someone (a new colleague in To:, or an unknown salesperson/service), so it was fetched again |
| `AI answered` | info | Which model drafted a mail (`groq:…` or `openrouter:…`), with `tokens` `{ input, output, cached }`; `cached` > 0 means the provider served part of the prompt from its cache |
| `AI answer unusable; trying next` | warning | A model's reply wasn't valid lead JSON |
| `model rejected json_schema; using json_object` | warning | A model doesn't support strict JSON schema |
| `lead created` | info | Lead created (`leadId`, `messageId`) |
| `mail sent to review` / `CRM refused lead` | info | Mail forwarded to the lead generator, with `reason` |
| `mail ignored` | info | Sender not allowed or failed authentication, with `reason` |
| `dry run: lead not created` | info | `DRY_RUN` only, with the payload |
| `AI model failed; trying next` | warning | One model errored |
| `processing failed; will retry` | error | Mail left for the next sweep |
| `alert sent` / `alert email failed` | info / error | Alert email outcome |
| `gmail search failed` / `gmail watch failed` | error | Gmail problems |
| `unhandled rejection` | error | Stray promise rejection |
| `uncaught exception` | critical | Crash; the process exits and Railway restarts it |

```logql
{app="ep-lead-intake", level="error"}                                # everything broken
{app="ep-lead-intake"} | json | messageId = "18f3a2b4c5d6e7f8"        # one mail's whole story
{app="ep-lead-intake"} | json | msg = "lead created"                  # leads created
{app="ep-lead-intake"} | json | msg = "AI model failed; trying next" | line_format "{{.model}} {{.err_message}}"
sum by (outcome) (count_over_time({app="ep-lead-intake"} | json | outcome != "" [1d]))
```

Secrets such as authorization headers, tokens and API keys are redacted. Client contact details do appear in review and dry-run lines, as they do in ep-crm's logs.
