# ep-lead-intake

Turns inquiry emails sent to a configurable mailbox (`INTAKE_MAILBOX`) into EP CRM leads.

How it works: Gmail sends a push notification and new mail joins a queue. Mails are processed one at a time. An AI model on OpenRouter drafts each lead, with several models rotated. Code checks every draft against the mail and the CRM's own lists, then creates the lead and replies to the sender. Anything that can't become a valid lead is forwarded to the lead generator. Failures are emailed to `ALERT_EMAIL`.

**Full usage, setup and configuration guide: [docs/SPEC.md](docs/SPEC.md).** Every environment variable is listed with comments in [example.env](example.env).

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Compile `src/` to `dist/` |
| `npm start` | Run the compiled server (production) |
| `npm run dev` | Run from source, reading `.env` |
| `npm run authorize` | One-time OAuth consent; prints `GMAIL_REFRESH_TOKEN` |
| `npm run dry-run -- <messageId>` | Draft and check one mail and print the result. No CRM call, no labels, no mail sent |
| `npm test` | Unit tests |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint |

## Quick start

```
npm install
cp example.env .env      # fill in the values
npm run authorize        # sign in as INTAKE_MAILBOX, paste the token into .env
npm run dry-run -- <gmail-message-id>
```

Deploy on Railway with **one replica**, build `npm run build`, start `npm start`, and `DRY_RUN=true` for the first days.
