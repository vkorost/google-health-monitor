// Pushover delivery. Not ntfy: ntfy.sh meters its free quota per source IP, and
// a Worker shares Cloudflare egress addresses with strangers (Nest lesson,
// HTTP 429 after twelve messages).
//
// Nothing in this app is urgent, so everything goes at normal priority.

export class NotifierError extends Error {}

export function buildNotifier(env) {
  const configured = Boolean(env.PUSHOVER_USER_KEY && env.PUSHOVER_TOKEN);
  return {
    name: configured ? "pushover" : "none",
    configured,
    async send(title, body) {
      if (!configured) {
        throw new NotifierError("Pushover is not configured: set PUSHOVER_USER_KEY and PUSHOVER_TOKEN as Worker secrets.");
      }
      const res = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: env.PUSHOVER_TOKEN, user: env.PUSHOVER_USER_KEY,
          title, message: body, priority: "0",
        }),
      });
      if (!res.ok) throw new NotifierError(`pushover HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
  };
}
