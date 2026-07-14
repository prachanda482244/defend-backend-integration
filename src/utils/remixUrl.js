/* ------------------------------------------------------------------ *
 *  remixUrl.js
 *
 *
 *
 *  src/utils/cron.js imports it. src/index.js imports cron.js. So Node
 *  threw:
 *
 *      ERR_MODULE_NOT_FOUND: Cannot find module '.../src/utils/remixUrl.js'
 *      imported from .../src/utils/cron.js
 *
 *  ...and the server never started. That is why no orders were being
 *  created. Nothing else was wrong with the renewal logic — the process
 *  was simply dead.
 *
 *  ------------------------------------------------------------------
 *  WHAT IT DOES
 *
 *  Resolves the URL of the Shopify app's order endpoint.
 *
 *  `SHOPIFY_APP_URL` is a NAME COLLISION. The Shopify CLI already defines
 *  it, and *its* value is the BASE tunnel URL with no path:
 *
 *      SHOPIFY_APP_URL=https://something.trycloudflare.com
 *
 *  But this backend POSTs straight to it. Set it the way Shopify documents
 *  it and the backend hits `/` — the Remix ROOT route, which has no action:
 *
 *      405  "You made a POST request to '/' but did not provide an
 *            `action` for route 'root'"
 *
 *  So we accept BOTH forms and normalise. And there is deliberately NO
 *  default: the old fallback was the PRODUCTION Remix app on Render, which
 *  writes real orders to defent.myshopify.com. A missing env var must be a
 *  loud failure, never a silent trip to prod.
 * ------------------------------------------------------------------ */

const ORDER_PATH = "/api/create-order";

/**
 * Returns the full POST target, e.g.
 *   https://abc.trycloudflare.com/api/create-order
 *
 * Accepts any of:
 *   https://abc.trycloudflare.com
 *   https://abc.trycloudflare.com/
 *   https://abc.trycloudflare.com/api/create-order
 *   "  https://abc.trycloudflare.com/api/create-order  "   (quoted/spaced)
 */
export function resolveRemixUrl() {
  const raw = String(process.env.SHOPIFY_APP_URL || "")
    .trim()
    .replace(/^["']|["']$/g, "") // strip stray quotes from the .env
    .trim();

  if (!raw) {
    throw new Error(
      "SHOPIFY_APP_URL is not set. Refusing to guess — the old fallback was " +
        "the PRODUCTION app (defent-shopify-app-1.onrender.com), which writes " +
        "real orders to defent.myshopify.com.\n" +
        "  Set it in the backend .env:\n" +
        "  SHOPIFY_APP_URL=https://your-tunnel.trycloudflare.com/api/create-order",
    );
  }

  const base = raw.replace(/\/+$/, ""); // strip trailing slashes
  if (base.endsWith(ORDER_PATH)) return base;

  // Someone gave us just the host (the Shopify CLI's format). Append the path.
  return `${base}${ORDER_PATH}`;
}

/** True when SHOPIFY_APP_URL was actually set (vs. missing). */
export const remixUrlIsExplicit = () =>
  Boolean(String(process.env.SHOPIFY_APP_URL || "").trim());

/** Did we have to append the path for them? For the boot banner. */
export function remixUrlWasNormalised() {
  const raw = String(process.env.SHOPIFY_APP_URL || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .replace(/\/+$/, "");
  return Boolean(raw) && !raw.endsWith(ORDER_PATH);
}
