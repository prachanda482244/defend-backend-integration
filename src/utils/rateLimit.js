/* ------------------------------------------------------------------ *
 *  rateLimit.js  (NEW — spec §9, bot protection on the API itself)
 *
 *  Minimal in-memory, per-IP sliding-window limiter. No dependency, so
 *  there is no npm install to forget on Render.
 *
 *  Scope: the PUBLIC intake endpoints (order create, unsubscribe). The
 *  Remix app's server-to-server calls (renewals, reconciler, confirm)
 *  can be exempted with an allowlist header secret if they ever share
 *  an origin pool with the public — see TRUSTED_HEADER below.
 *
 *  Honest limits of in-memory limiting: state is per-process and resets
 *  on deploy. That's fine for the current single-instance Render setup;
 *  if the backend ever scales to multiple instances, swap the Map for
 *  Redis — the middleware interface stays the same.
 * ------------------------------------------------------------------ */

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000); // 10 min
const MAX_HITS = Number(process.env.RATE_LIMIT_MAX || 20); // per IP per window

/* Server-to-server calls (Remix renewals/reconciler) bypass the limit by
   presenting this shared secret. Unset = nothing is trusted. */
const TRUSTED_HEADER = "x-internal-key";
const TRUSTED_SECRET = process.env.INTERNAL_API_KEY || "";

const hits = new Map(); // ip -> number[] of timestamps

/* Don't let the map grow forever. */
setInterval(
  () => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [ip, times] of hits) {
      const alive = times.filter((t) => t > cutoff);
      if (alive.length) hits.set(ip, alive);
      else hits.delete(ip);
    }
  },
  Math.min(WINDOW_MS, 5 * 60 * 1000),
).unref();

export function rateLimit(req, res, next) {
  if (TRUSTED_SECRET && req.get(TRUSTED_HEADER) === TRUSTED_SECRET) {
    return next();
  }

  // Render sits behind a proxy; x-forwarded-for's FIRST hop is the client.
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const times = (hits.get(ip) || []).filter((t) => t > cutoff);

  if (times.length >= MAX_HITS) {
    res.set("Retry-After", String(Math.ceil(WINDOW_MS / 1000)));
    return res.status(429).json({
      statusCode: 429,
      data: null,
      message: "Too many requests — please wait a few minutes and try again.",
      success: false,
    });
  }

  times.push(now);
  hits.set(ip, times);
  next();
}
