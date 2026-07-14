/* ------------------------------------------------------------------ *
 *  unsubscribeToken.js  (NEW)
 *
 *  Stateless, unforgeable unsubscribe links.
 *
 *  Format:  <base64url(payload-json)>.<base64url(hmac-sha256)>
 *  Payload: { o: orderId, c: cycle, e: expiryEpochSeconds }
 *
 *  Why HMAC and not "?orderId=<mongo id>":
 *    A raw Mongo id in a URL is guessable/enumerable — anyone could
 *    cancel someone else's subscription. The signature means a token is
 *    only valid if WE minted it.
 *
 *  Why the cycle is inside the token:
 *    It ties the link to the email that carried it, so you get a clean
 *    audit trail of which reminder the customer acted on.
 * ------------------------------------------------------------------ */

import crypto from "crypto";

const DEFAULT_TTL_DAYS = Number(process.env.UNSUBSCRIBE_TTL_DAYS || 365);

function secret() {
  const s = process.env.UNSUBSCRIBE_SECRET;
  if (!s || s.length < 16) {
    // Thrown at USE time, not import time, so a missing env var can never
    // stop the server from booting.
    throw new Error(
      "Missing/short env variable: UNSUBSCRIBE_SECRET (use >= 32 random chars)",
    );
  }
  return s;
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (str) => Buffer.from(String(str), "base64url");

function hmac(data) {
  return crypto.createHmac("sha256", secret()).update(data).digest();
}

/** Mint a token for one (order, cycle). */
export function signUnsubToken({ orderId, cycle, ttlDays = DEFAULT_TTL_DAYS }) {
  if (!orderId) throw new Error("orderId required to sign unsubscribe token");

  const payload = {
    o: String(orderId),
    c: String(cycle || ""),
    e: Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60,
  };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(hmac(body));
  return `${body}.${sig}`;
}

/**
 * Verify + decode. NEVER throws — always returns a result object so the
 * route can render a friendly page instead of a 500.
 *   -> { ok: true,  orderId, cycle, expiresAt }
 *   -> { ok: false, reason: "malformed" | "bad_signature" | "expired" | "misconfigured" }
 */
export function verifyUnsubToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "malformed" };
  }

  const [body, sig] = token.split(".", 2);
  if (!body || !sig) return { ok: false, reason: "malformed" };

  let expected;
  try {
    expected = hmac(body);
  } catch {
    return { ok: false, reason: "misconfigured" };
  }

  let got;
  try {
    got = unb64u(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Length check first: timingSafeEqual throws on a length mismatch.
  if (got.length !== expected.length)
    return { ok: false, reason: "bad_signature" };
  if (!crypto.timingSafeEqual(got, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload;
  try {
    payload = JSON.parse(unb64u(body).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (!payload?.o) return { ok: false, reason: "malformed" };
  if (payload.e && Math.floor(Date.now() / 1000) > Number(payload.e)) {
    return { ok: false, reason: "expired" };
  }

  return {
    ok: true,
    orderId: String(payload.o),
    cycle: String(payload.c || ""),
    expiresAt: payload.e ? new Date(Number(payload.e) * 1000) : null,
  };
}

/** Full public URL that goes in the email button. */
export function buildUnsubUrl({ orderId, cycle }) {
  const base = (process.env.PUBLIC_API_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("Missing env variable: PUBLIC_API_URL");
  const token = signUnsubToken({ orderId, cycle });
  return `${base}/api/v1/subscription/unsubscribe?t=${encodeURIComponent(token)}`;
}
