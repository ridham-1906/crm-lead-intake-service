// One-time OAuth consent: sign in as the intake mailbox (INTAKE_MAILBOX) and copy the printed refresh token into GMAIL_REFRESH_TOKEN.
import { createServer } from "node:http";
import { OAuth2Client } from "google-auth-library";
import { SCOPES } from "../src/gmail.js";

const PORT = Number(process.env.AUTHORIZE_PORT ?? 53682);
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (in .env or the shell) first.");
  process.exit(1);
}

const redirectUri = `http://127.0.0.1:${PORT}/callback`;
const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

const server = createServer(async (req, res) => {
  const reqUrl = new URL(req.url ?? "/", redirectUri);
  if (reqUrl.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = reqUrl.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end(`Authorization failed: ${reqUrl.searchParams.get("error") ?? "no code"}`);
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    res.writeHead(200).end("Done. You can close this tab and return to the terminal.");
    if (tokens.refresh_token) {
      console.log(`\nGMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    } else {
      console.error("No refresh token returned. Revoke the app's access in the Google account and run again.");
    }
  } catch (err) {
    res.writeHead(500).end("Token exchange failed; see the terminal.");
    console.error((err as Error).message);
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Open this URL, signed in as ${process.env.INTAKE_MAILBOX ?? "the intake mailbox"}:\n`);
  console.log(url);
});
