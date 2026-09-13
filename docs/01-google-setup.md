# Setup: Google Health API and OAuth

One-time setup. Budget about 45 minutes. It costs nothing, and no billing account is needed.

By the end you will have three things the Worker needs, all in `.secrets/` (gitignored):

| Value | Where it comes from |
|---|---|
| `client_id`, `client_secret` | Step 5, the downloaded `client_secret.json` |
| `refresh_token` | Step 6, written to `.secrets/token.json` by the probe script |

You will also know whether your sources reach the API at all, which decides whether the rest of this project is worth doing.

---

## Step 0: The phone side (check first)

The API only sees what the **Google Health app** has synced from Health Connect. On the Android phone:

1. **Source apps write to Health Connect.**
   - **Samsung Health:** three-dot menu, Settings, Health Connect. It should show connected.
   - **Polar Flow, scale apps:** each app's own settings.
2. **Health Connect actually holds the data.** Android Settings, search "Health Connect", then Data and access (or Browse data). Open Heart rate and Sleep and look for recent entries from your apps. Permissions alone prove nothing.
3. **The Google Health app reads Health Connect.** Install it, sign in with the Google account you will use below, and turn on its Health Connect connection with read access.
4. **Battery.** Android Settings, Apps: set **Google Health** and **Samsung Health** battery use to **Unrestricted**. Samsung phones are known for killing background sync.
5. **Open each app once after updates.** A Samsung Health update that asks onboarding questions stops writing until it is opened.

---

## Step 1: Create the Google Cloud project

1. Go to https://console.cloud.google.com/projectcreate
2. Name it (for example `health-monitor`), with no organization. Create it.
3. Check that the project picker at the top shows it before continuing.

## Step 2: Enable the Google Health API

Go to https://console.cloud.google.com/apis/library/health.googleapis.com, confirm the project, and click **Enable**.

## Step 3: Configure the consent screen

1. Go to https://console.cloud.google.com/auth/overview and click **Get started**.
2. **Fill in the four sections:**
   - **App information:** app name `Health Monitor`, your email as support email.
   - **Audience:** **External**.
   - **Contact information:** your email.
   - **Finish:** accept the user data policy.
3. Click **Create**. If Data Access later says "Google Auth Platform not configured yet", this step did not save; run it again.

## Step 4: Scopes and test user

1. **Data Access**, **Add or remove scopes**. Filter on `googlehealth` and tick exactly:
   - `.../auth/googlehealth.activity_and_fitness.readonly`
   - `.../auth/googlehealth.health_metrics_and_measurements.readonly`
   - `.../auth/googlehealth.sleep.readonly`
2. Click **Update**, then **Save** at the bottom of the page. Without Save they are not kept.
3. **Audience**, **Test users**, **Add users**: add your own Google account.

## Step 5: Create the OAuth client

1. **Clients**, **Create client**, application type **Web application**.
2. Under **Authorized redirect URIs**, add exactly:

   ```
   https://www.google.com
   ```

   No trailing slash. It looks wrong because nothing runs there, but the authorization code comes back as a query parameter on that page, and you copy it from the address bar.
3. **Create**, then **Download JSON**. Save it as `.secrets/client_secret.json` in the repo root.

Open the downloaded file and check that `redirect_uris` is not empty. An empty list means the URI was not saved, and sign-in will fail with `redirect_uri_mismatch`.

## Step 6: Authorize and probe

```bash
python tools/gh_probe.py auth
```

1. It prints a sign-in URL. Open it in a browser signed in **only** as the target account.
2. On "Google hasn't verified this app", choose **Advanced**, then continue. That is expected for your own app.
3. Tick every permission box and continue.
4. You land on a google.com page. Copy the whole address bar URL (`https://www.google.com/?code=...`) and paste it at the prompt. In a non-interactive shell, pass it with `--url "..."` instead.

The code works once and expires within minutes; if you are slow, run `auth` again. The refresh token goes to `.secrets/token.json`, readable only by your user.

Then look at what the API has:

```bash
python tools/gh_probe.py probe
python tools/gh_probe.py probe --days 400 --types heart-rate,sleep,weight
```

For each type it prints the point count, the time span, and the source fields. Raw pages go to `probe-output/`. What to look for:

- **`dataSource.platform=HEALTH_CONNECT`** with `application.packageName=com.sec.android.app.shealth` (or your other apps): phone data reaches the cloud. Good.
- **Only `platform=FITBIT` and `MobileTrack`:** only Google's own phone step counter is arriving. Recheck Step 0.
- **Empty types:** some are normal. Samsung does not share HRV, skin temperature, respiratory rate or resting heart rate, and sends SpO2 and steps only as daily summaries (look in the `daily-oxygen-saturation` type and in `steps`).
- **Newest record days old:** a source app has not synced. Open it, sync Google Health, probe again. Missed days usually backfill.

## Step 7: Publish the app (within 7 days)

While the app sits in **Testing**, Google expires every refresh token after exactly 7 days, and the Worker loses access weekly. Publish it:

1. **Branding:** add an application homepage URL and a privacy policy URL. The Worker serves both, at `https://<your-host>/about` and `https://<your-host>/privacy`. They must be reachable without signing in, so set up the Access Bypass application in [docs/02-cloudflare-deploy.md](02-cloudflare-deploy.md) first.
2. **Audience**, **Publish app**. If the button is greyed out, hover it; the message names what is missing.
3. After publishing, run `python tools/gh_probe.py auth` once more for a non-expiring refresh token, and update the `GOOGLE_REFRESH_TOKEN` Worker secret.

The Google Health API's scopes are restricted. An unverified app is limited to 100 users, which does not matter for one person. Do not start the verification or security-assessment process; it is only for apps with more users.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` | Step 5 URI not saved, or has a trailing slash |
| `invalid_grant` on exchange | The code was already used or has expired. Run `auth` again. |
| No `refresh_token` returned | Consent screen skipped. The script sends `prompt=consent`; revoke the app at https://myaccount.google.com/permissions and retry. |
| Refresh fails after about 7 days | App still in Testing (Step 7) |
| Types return data but nothing recent | A source app has not synced (Step 0) |
| HTTP 400 `INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER` | Sleep and exercise reject `interval.start_time` filters. See ASSIGNMENT.md traps. |
