# Deploy to Cloudflare

Budget about an hour. Everything here fits the free tiers. Do [docs/01-google-setup.md](01-google-setup.md) first: you need `.secrets/client_secret.json` and `.secrets/token.json`.

Run commands from the repo root. On Windows, use `wrangler d1 execute --file`, never `--command`; quoting breaks.

```bash
cp wrangler.jsonc.example wrangler.jsonc     # gitignored; fill it in as you go
npx wrangler login
```

---

## Step 1: The database

```bash
npx wrangler d1 create healthmon
```

Copy the printed `database_id` into `wrangler.jsonc`, then apply the schema:

```bash
npx wrangler d1 execute healthmon --remote --file=schema.sql
```

## Step 2: Hostname and timezone

In `wrangler.jsonc`:

- **`routes[0].pattern`:** a hostname on a zone in your Cloudflare account, for example `health.example.com`. Deploy creates the DNS record.
- **`vars.TZ`:** your IANA timezone. Local dates, the nightly wake date and quiet hours use it.
- **`triggers.crons`:** shift them so both runs fall outside 22:00 to 08:00 local.
- **`vars.ALLOWED_EMAIL`:** the Google account that may open the dashboard.

`workers_dev` and `preview_urls` stay `false`. A workers.dev URL would be a second door around Access.

## Step 3: Cloudflare Access with Google sign-in

The dashboard holds a health record, so it sits behind Access, and the Worker verifies the Access token itself.

### 3a. Zero Trust team

Open https://one.dash.cloudflare.com. On first use, pick a **team name**; your team domain becomes `https://<team>.cloudflareaccess.com`. Choose the Free plan (50 users). If an existing account already shows a team under Settings, use that one.

### 3b. A Google login client for Access

This is a **second** OAuth client, separate from the one the Worker uses. In the same Google Cloud project, **Clients**, **Create client**, **Web application**:

- **Authorized JavaScript origins:** `https://<team>.cloudflareaccess.com`
- **Authorized redirect URIs:** `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`

Keep the client ID and secret for the next step. They go into Cloudflare only; delete the downloaded JSON afterwards.

### 3c. Add Google as an identity provider

Zero Trust, **Integrations**, **Identity providers**, **Add**, **Google**. Paste the ID and secret, save, and click **Test**: it should sign you in. If Google is already listed and the test passes, reuse it.

### 3d. The application

**Access controls**, **Applications**, **Add an application**, **Self-hosted**:

1. **Destination:** your hostname, path empty.
2. **Access policy.** Create a new policy named `Owner`, action **Allow**.
   - **The Include rule has two parts.** First choose **Emails** in the selector, then type your address in the value field that appears and press Enter.
   - Typing the address straight into the selector shows "No valid options", and the policy matches nobody.
3. **Authentication:** select **Google** only. Leave instant authentication on.
4. **Name** `Health Monitor`, session duration as you like. **Create**.
5. Open the application again and copy the **Application Audience (AUD) Tag**.

In `wrangler.jsonc` set:

```jsonc
"ACCESS_TEAM_DOMAIN": "https://<team>.cloudflareaccess.com",
"ACCESS_AUD": "<the AUD tag>"
```

Neither is secret. Until both are set, every data route answers 503, deliberately.

### 3e. Public pages for Google's publishing check

Google needs `/about` and `/privacy` reachable without signing in before it lets you publish the OAuth app. Access protects the whole hostname, so add a **second** self-hosted application:

- **Destinations:** `<your host>/about` and `<your host>/privacy`.
- **Policy:** action **Bypass**, include **Everyone**.

Both pages are static text and carry no data.

## Step 4: Secrets

Five secrets: three from `.secrets/`, two from Pushover. Create a temporary JSON file **outside the repo or inside `.secrets/`**:

```json
{
  "GOOGLE_CLIENT_ID": "<client_secret.json: web.client_id>",
  "GOOGLE_CLIENT_SECRET": "<client_secret.json: web.client_secret>",
  "GOOGLE_REFRESH_TOKEN": "<token.json: refresh_token>",
  "PUSHOVER_USER_KEY": "<your Pushover user key>",
  "PUSHOVER_TOKEN": "<a Pushover application token named Health Monitor>"
}
```

```bash
npx wrangler deploy                       # the Worker must exist before secrets can attach
npx wrangler secret bulk .secrets/bulk-secrets.json
rm .secrets/bulk-secrets.json
npx wrangler secret list                  # names only, never values
```

Secrets take a few seconds to reach the Worker; retry before debugging. Without the Pushover secrets, alerts are still recorded, just not delivered, and the dashboard says so.

## Step 5: Import history

```bash
node tools/backfill.mjs                   # 12 months of 15-minute heart rate + all summaries
node tools/backfill.mjs --hr-days 90      # less heart-rate history
```

Set `HEALTH_TZ` to the same zone as `vars.TZ` if it is not `America/New_York`. The script writes `import/NN-*.sql` (gitignored) and prints the row writes per file. Load them in order:

```bash
for f in import/*.sql; do npx wrangler d1 execute healthmon --remote --file="$f"; done
```

```powershell
Get-ChildItem import\*.sql | Sort-Object Name | ForEach-Object { npx wrangler d1 execute healthmon --remote --file=$($_.FullName) }
```

The default import is about 40,000 row writes, inside the 100,000 daily free quota. Every statement is an upsert, so re-running a file is safe.

## Step 6: Deploy and check

```bash
npx wrangler deploy
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -A "Mozilla/5.0" https://<your host>/api/summary
```

An unauthenticated request must redirect (302) to `<team>.cloudflareaccess.com`. Scripts need a normal `User-Agent`: Cloudflare answers default library user agents with HTTP 403 and `error code: 1010` before the Worker sees them.

Then, in a browser:

1. Open `https://<your host>` and sign in with Google.
2. **Data health**, **Pull now**. The result line shows what arrived.
3. **Alerts**, **Send test notification**. It should reach your phone.

## Operating notes

- **Two pulls a day.** Each re-reads the last 3 days, and more after a gap (up to 14), so data that reaches Google late is picked up without intervention.
- **"Watch data stopped" is the alert that matters.** It usually means a phone app has not synced: open Samsung Health (especially after an update) and the Google Health app.
- **"Google access lost"** means the refresh token died. The usual cause is an OAuth app still in Testing after 7 days. Publish it (docs/01, Step 7), re-run `tools/gh_probe.py auth`, and update `GOOGLE_REFRESH_TOKEN`.
- **Logs:** `npx wrangler tail`.
