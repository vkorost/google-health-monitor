// Worker entry point.
//
//   scheduled()  twice a day - pull from Google Health, store, alert
//   fetch()      the dashboard and its JSON API, behind Cloudflare Access
//
// Nothing survives between invocations except D1. Every run is a cold isolate.

import * as db from "./db.js";
import { verifyAccess } from "./access.js";
import { buildNotifier } from "./notify.js";
import { pullOnce } from "./pull.js";
import { PAGE } from "./ui.js";
import { ICON_192, ICON_512, ICON_MASKABLE_512 } from "./icons.js";
import { dayView, exportCsv, healthView, summaryView, trendsView } from "./views.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const html = (body, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });

// Public pages exist only because Google requires a homepage and a privacy
// policy URL before an OAuth app can be published. They carry no data.
const PUBLIC_STYLE = "body{font:16px/1.6 -apple-system,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:32px 16px;color:#1b1e23;background:#f6f7f9}h1{font-size:24px}a{color:#1a5fb4}";
const ABOUT = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Health Monitor</title><style>${PUBLIC_STYLE}</style>
<h1>Health Monitor</h1>
<p>A private, single-user dashboard. It reads its owner's own sleep, heart rate, workout and body-composition data from the Google Health API once or twice a day, stores daily summaries, and charts long-term trends for that one person.</p>
<p>It is not a public service and does not accept sign-ups. The dashboard itself is restricted to its owner.</p>
<p><a href="/privacy">Privacy policy</a></p>`;
const PRIVACY = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Health Monitor privacy policy</title><style>${PUBLIC_STYLE}</style>
<h1>Privacy policy</h1>
<p>Health Monitor is a personal tool used by one person, its owner, on their own Google account.</p>
<h2>What it accesses</h2>
<p>Read-only access, through the Google Health API, to the owner's activity and fitness, health metrics and measurements, and sleep data. It never writes to Google Health.</p>
<h2>What it stores</h2>
<p>Summaries of that data (15-minute heart-rate ranges, sleep sessions and stages, workouts, weight and body-fat readings, daily step totals, and nightly values the owner imports from their own Samsung Health export) in a database on the owner's own Cloudflare account. Nothing is shared with, sold to, or disclosed to anyone else, and nothing is used for advertising.</p>
<h2>Who can see it</h2>
<p>Only the owner. The dashboard sits behind Cloudflare Access and accepts a single Google account.</p>
<h2>Deleting data</h2>
<p>Revoking the app at myaccount.google.com/permissions stops all access. The owner can delete the stored database at any time.</p>`;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const result = await pullOnce(env, "cron");
        if (!result.ok) console.error(`pull error: ${result.error}`);
        for (const s of result.sent) console.log(`ALERT ${s.type} ${s.direction}`);
        if (new Date().getUTCHours() === 12) await db.prune(env.DB);
      })()
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/about") return html(ABOUT);
    if (url.pathname === "/privacy") return html(PRIVACY);
    // Icons and the manifest carry no data. Access still sits in front of them at
    // the edge, which is fine: the browser sends the Access cookie for same-origin requests.
    const icon = { "/favicon.ico": ICON_192, "/icon-192.png": ICON_192, "/icon-512.png": ICON_512, "/icon-maskable-512.png": ICON_MASKABLE_512 }[url.pathname];
    if (icon) return new Response(Uint8Array.from(atob(icon), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/png", "cache-control": "public, max-age=604800" } });
    if (url.pathname === "/manifest.webmanifest") {
      return new Response(JSON.stringify({
        name: "Health Monitor", short_name: "Health", start_url: "/", display: "standalone",
        background_color: "#15171b", theme_color: "#55488d",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      }), { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=86400" } });
    }

    // Fail closed: without Access configuration nothing below is served.
    const gate = await verifyAccess(request, env);
    if (!gate.ok) return new Response(gate.message, { status: gate.status, headers: { "content-type": "text/plain; charset=utf-8" } });

    try {
      if (url.pathname === "/") return html(PAGE);
      if (url.pathname === "/api/summary") return json(await summaryView(env, gate.email));
      if (url.pathname === "/api/day") return json(await dayView(env, url.searchParams.get("date")));
      if (url.pathname === "/api/trends") return json(await trendsView(env, url.searchParams.get("range")));
      if (url.pathname === "/api/health") return json(await healthView(env));
      if (url.pathname === "/api/export.csv") return exportCsv(env, url.searchParams.get("range"));

      if (url.pathname === "/api/settings") {
        if (request.method === "POST") return json({ ok: true, settings: await db.setSettings(env.DB, await request.json()) });
        return json({ settings: await db.getSettings(env.DB), notifier: buildNotifier(env).name });
      }

      if (request.method === "POST" && url.pathname === "/api/test-notification") {
        const notifier = buildNotifier(env);
        try {
          await notifier.send("Health Monitor: test", "Delivery works. Real alerts arrive only when data stops, a pull fails, or Google access is lost.");
        } catch (err) {
          return json({ ok: false, error: err.message }, notifier.configured ? 502 : 400);
        }
        return json({ ok: true, via: notifier.name });
      }

      if (request.method === "POST" && url.pathname === "/api/pull-now") {
        return json(await pullOnce(env, "manual"));
      }

      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: String(err.message || err) }, 500);
    }
  },
};
