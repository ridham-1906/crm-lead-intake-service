# Google Cloud setup

This guide sets up Google Cloud and Gmail for ep-lead-intake, step by step. When you finish, every Google value the service needs is in `.env`:

| Variable | Set in step |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 3 |
| `GMAIL_REFRESH_TOKEN` | 4 |
| `GMAIL_INTAKE_LABEL` | 5 |
| `GMAIL_PUBSUB_TOPIC` | 6 |
| `PUBSUB_SERVICE_ACCOUNT` | 9 |
| `PUBSUB_AUDIENCE` | 8 |

**How it works:**
1. Gmail labels each forwarded inquiry `Lead-Intake`.
2. Gmail notifies the Pub/Sub topic.
3. Pub/Sub pushes to `https://<your-domain>/gmail/push`.
4. The service reads the mail and creates the lead.

The service registers the Gmail watch itself when it starts; you don't call `watch` by hand.

**Cost:** Gmail API and Pub/Sub usage at this volume stays inside the free tier, but Pub/Sub still needs a billing account linked to the project.

---

## 1. Create the project

1. In the top bar, open the project picker → **New project**. Give it a name, for example `ep-crm-lead-intake-service`.
2. Note the **Project ID** shown under the name. You need it for the topic name in step 6.
3. Go to **Billing** → **Link a billing account**.

## 2. Enable the APIs

Go to **APIs & Services → Library**, then search for each API and click **Enable**:

- **Gmail API**
- **Cloud Pub/Sub API**

## 3. OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)

1. Go to **APIs & Services → OAuth consent screen** (newer consoles call it **Google Auth Platform**) and click **Get started**.
   - **App name:** `ep-lead-intake`. **Support email:** your own.
   - **Audience:** **Internal**. This limits the app to your Workspace and skips Google's app review.
2. Go to **Credentials → Create credentials → OAuth client ID** (newer consoles: **Google Auth Platform → Clients → Create client**).
   - **Application type:** **Desktop app**, not Web application. It needs no redirect URIs or JavaScript origins.
3. Click **Create**. Copy both values now, or click **Download JSON**; the secret may not be shown again.

```env
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxx
```

## 4. Refresh token (`GMAIL_REFRESH_TOKEN`)

1. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `INTAKE_MAILBOX` in `.env`.
2. Run:
   ```bash
   npm install
   npm run authorize
   ```
3. Open the URL it prints. Sign in as the **intake mailbox**, the same address as `INTAKE_MAILBOX`, not your own account. Click **Allow**.
4. Paste the line it prints, `GMAIL_REFRESH_TOKEN=1//0g…`, into `.env`.

| Problem | Fix |
|---|---|
| "No refresh token returned" | The account already approved the app. Remove its access at myaccount.google.com → **Security → Third-party connections**, then run `npm run authorize` again. |
| `invalid_grant` at startup | The token came from a different OAuth client, for example an old Web client. Check that `.env` holds the Desktop client's ID and secret, then authorize again. |
| Startup says the mailbox doesn't match | You signed in as a different account. Authorize again, signed in as `INTAKE_MAILBOX`. |

## 5. Gmail label and filter (`GMAIL_INTAKE_LABEL`)

Do this in the **intake mailbox's** Gmail. Nobody labels mail by hand; the filter does it.

1. Go to **Settings → Labels → Create new label** → `Lead-Intake`.
2. Go to **Settings → Filters and blocked addresses → Create a new filter**.
   - **From:** the people who forward inquiries. Separate several senders with `OR`:
     `cofounder@excellentpublicity.com OR other@excellentpublicity.com`
   - Click **Create filter**, tick **Apply the label: Lead-Intake**, then click **Create filter** again.

```env
GMAIL_INTAKE_LABEL=Lead-Intake
```

Keep the filter's senders the same as `ALLOWED_SENDERS` in `.env`; the service skips mail from anyone else. To add a sender later, add `OR new@…` to the filter's **From** field and add the address to `ALLOWED_SENDERS`.

## 6. Pub/Sub topic (`GMAIL_PUBSUB_TOPIC`)

1. Go to **Pub/Sub → Topics → Create topic**.
   - **Topic ID:** `gmail-leads`.
   - Untick **Add a default subscription**; you create the push subscription in step 10.
2. The topic's full name is shown on its page:

```env
GMAIL_PUBSUB_TOPIC=projects/<project-id>/topics/gmail-leads
```

## 7. Let Gmail publish to the topic

1. Open **Pub/Sub → Topics → gmail-leads → Permissions** (or **Show info panel**) → **Add principal**.
   - **Principal:** `gmail-api-push@system.gserviceaccount.com`
   - **Role:** **Pub/Sub Publisher**
2. Click **Save**.

Without this permission, Gmail can't notify the service and new mail is only picked up by the periodic sweep (`SWEEP_INTERVAL_MINUTES`).

### If you get "IAM policy update failed … Domain Restricted Sharing"

Your organization only allows accounts from your own domain. `gmail-api-push@system.gserviceaccount.com` is owned by Google, so it is blocked. To get past this, turn the rule off for this project only, add the permission, then turn the rule back on. A permission added while the rule is off keeps working afterwards, because the rule only blocks new grants.

**a. Get the right role.** Changing the policy needs **Organization Policy Administrator** (`roles/orgpolicy.policyAdmin`). If **Manage policy** is greyed out, you don't have it yet.

- **Organization Administrator** is *not* enough. It can view policies, but it can grant you the role you need.
- The role is only listed when you grant access on the **organization**, not on the project:
  1. In the top bar, open the resource picker and choose the **organization** (building icon, your domain name).
  2. Go to **IAM & Admin → IAM → Grant access**.
     - **Principal:** your email.
     - **Role:** **Organization Policy → Organization Policy Administrator**.
- Or, from Cloud Shell (the `>_` icon, top right):
  ```bash
  gcloud organizations list          # copy the ID
  gcloud organizations add-iam-policy-binding ORG_ID \
    --member="user:YOUR_EMAIL" \
    --role="roles/orgpolicy.policyAdmin"
  ```
- If this fails with *permission denied*, ask the Google Workspace super admin to grant you the role.

**b. Turn the rule off for the project.**

1. Select the **project** in the top bar.
2. Go to **IAM & Admin → Organization Policies**. Open **Domain restricted sharing** (`iam.allowedPolicyMemberDomains`).
3. Click **Manage policy**:
   - **Policy source:** **Override parent's policy**.
   - **Rules → Add a rule → Policy values:** **Allow All**.
   - Click **Set policy**.
4. Wait 1–2 minutes.

**c. Add the permission.** Repeat step 7 from the top. It should save this time.

**d. Turn the rule back on.** Open the policy again → **Manage policy → Inherit parent's policy → Set policy**.

## 8. Public URL (`PUBSUB_AUDIENCE`)

Pub/Sub needs an HTTPS URL that reaches the service.

- **Production (Railway):** open the service → **Settings → Networking → Generate Domain**.
- **Local testing:** run `ngrok http 3000` (use your `PORT`) and use the `https://…ngrok-free.app` address. The free ngrok address changes every time it restarts. When it does, update `PUBSUB_AUDIENCE` and the subscription in step 10.

```env
PUBSUB_AUDIENCE=https://<your-domain>/gmail/push
```

## 9. Push service account (`PUBSUB_SERVICE_ACCOUNT`)

Pub/Sub signs every push with this account, and the service rejects pushes signed by anyone else.

1. Go to **IAM & Admin → Service Accounts → Create service account**.
   - **Name:** `gmail-push`.
   - Skip the **roles** and **user access** steps, then click **Done**.
2. Copy its email:

```env
PUBSUB_SERVICE_ACCOUNT=gmail-push@<project-id>.iam.gserviceaccount.com
```

This account belongs to your own project, so Domain Restricted Sharing doesn't block it.

## 10. Push subscription

Go to **Pub/Sub → Subscriptions → Create subscription** and fill it in:

| Field | Value |
|---|---|
| Subscription ID | `gmail-leads-push` |
| Topic | `projects/<project-id>/topics/gmail-leads` |
| Delivery type | **Push** |
| Endpoint URL | exactly the `PUBSUB_AUDIENCE` value |
| Enable authentication | ticked |
| Service account | `gmail-push@…` from step 9 |
| Audience | the same URL again |
| Acknowledgement deadline | 30 seconds |

Click **Create**.

## 11. Final check

- [ ] **Pub/Sub → Topics → gmail-leads → Permissions** lists `gmail-api-push@system.gserviceaccount.com` as **Pub/Sub Publisher**.
- [ ] The subscription's endpoint and audience both equal `PUBSUB_AUDIENCE`.
- [ ] The intake mailbox has the `Lead-Intake` label and the filter.
- [ ] `.env` has all six Google variables, with no placeholders left.
- [ ] Production only: `NODE_ENV=production` is set in Railway.

Start the service. The console should print `gmail watch renewed (…), expires …`; if it says `gmail watch failed`, check steps 6 and 7. Then forward a test inquiry from an allowed sender: the mail should get the `Lead-Intake` label within seconds and then `CRM-Done` or `CRM-Review`.
