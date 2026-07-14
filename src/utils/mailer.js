/* ------------------------------------------------------------------ *
 *  mailer.js  (NEW)  — Resend transport
 *
 *  Deliberately uses `axios` (already a dependency) instead of the
 *  `resend` SDK, so this adds ZERO new packages to package.json.
 *
 *  Three things keep this safe at 100+ emails/day:
 *
 *   1) BATCH  — POST /emails/batch sends up to 100 emails in ONE request.
 *               100 reminders = 1 API call, not 100. This is the whole
 *               ballgame: Resend's default limit is ~2 req/s, so looping
 *               `send()` 100 times is an instant 429.
 *
 *   2) IDEMPOTENCY — Resend honours an `Idempotency-Key` header on
 *               /emails and /emails/batch for 24h. If our process dies
 *               after Resend accepted the batch but before we recorded
 *               it, the retry sends the SAME key -> Resend returns the
 *               original response and does NOT re-send. No double emails.
 *
 *   3) PACE + BACKOFF — a serial pacer spaces requests, and withRetry()
 *               honours Retry-After on a 429.
 *
 *  NOTE ON `headers`: Resend's batch endpoint does not support
 *  `attachments` or `tags`. Per-email `headers` (we use List-Unsubscribe)
 *  are supported, but if a future API change rejects them we degrade
 *  gracefully instead of dropping the whole batch — see sendBatch().
 * ------------------------------------------------------------------ */

import axios from "axios";
import { withRetry, createPacer } from "./retry.js";

const RESEND_BASE = "https://api.resend.com";

/* Resend's documented default is ~2 req/s. 600ms ≈ 1.6 req/s — safely
   under it, and irrelevant in practice because we batch. */
const paced = createPacer(Number(process.env.RESEND_PACE_MS || 600));

const BATCH_MAX = 100; // hard limit imposed by Resend

function apiKey() {
  const k = process.env.RESEND_API_KEY;
  if (!k) throw new Error("Missing env variable: RESEND_API_KEY");
  return k;
}

function fromAddress() {
  // Must be on a domain you've verified in Resend, or it 403s.
  return process.env.RESEND_FROM || "DEFENT <noreply@defent.com>";
}

function client() {
  return axios.create({
    baseURL: RESEND_BASE,
    timeout: 20_000,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
  });
}

/** Chunk an array into slices of `size`. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Build one Resend email object.
 *   msg = { to, subject, html, text, unsubUrl? }
 */
function toResendEmail(msg) {
  const email = {
    from: fromAddress(),
    to: [msg.to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  };

  const replyTo = process.env.RESEND_REPLY_TO;
  if (replyTo) email.reply_to = replyTo;

  /* RFC 8058 one-click unsubscribe. Gmail/Yahoo REQUIRE List-Unsubscribe
     for bulk senders, and it materially improves inbox placement.
     The URL POSTs straight to our unsubscribe route. */
  if (msg.unsubUrl) {
    email.headers = {
      "List-Unsubscribe": `<${msg.unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }
  return email;
}

/**
 * Send up to N emails. Automatically chunks to 100/request.
 *
 * @param {Array} messages  [{ to, subject, html, text, unsubUrl? }]
 * @param {string} idempotencyKeyPrefix  stable per logical send (e.g.
 *        "reminder-15d/2026-07-13"). Each CHUNK appends its index so the
 *        key identifies exactly one request, as Resend requires.
 *
 * @returns {{ sent:number, failed:number, ids:string[], errors:string[] }}
 *
 * Never throws: a failed chunk is reported, not fatal — the caller marks
 * those reminders "failed" and the next cron run retries them.
 */
export async function sendBatch(messages, { idempotencyKeyPrefix } = {}) {
  const result = { sent: 0, failed: 0, ids: [], errors: [] };
  if (!messages?.length) return result;

  const http = client();
  const chunks = chunk(messages, BATCH_MAX);

  for (let i = 0; i < chunks.length; i += 1) {
    const group = chunks[i];
    const payload = group.map(toResendEmail);

    const headers = {};
    if (idempotencyKeyPrefix) {
      // Must be unique per request, ≤256 chars, and stable across retries.
      headers["Idempotency-Key"] = `${idempotencyKeyPrefix}/${i}`.slice(0, 256);
    }

    const post = (body) =>
      paced(() =>
        withRetry(() => http.post("/emails/batch", body, { headers }), {
          retries: 4,
          baseMs: 800,
          label: "resend:batch",
        }),
      );

    try {
      let res;
      try {
        res = await post(payload);
      } catch (err) {
        /* Graceful degradation: if Resend ever rejects per-email `headers`
           on the batch endpoint (422), resend the chunk WITHOUT them
           rather than losing 100 emails. The unsubscribe link is still in
           the body — only the mail-client "Unsubscribe" button is lost. */
        const status = err?.response?.status;
        const hasHeaders = payload.some((e) => e.headers);
        if (status === 422 && hasHeaders) {
          console.warn(
            "[mailer] batch rejected with headers — retrying without List-Unsubscribe",
          );
          const stripped = payload.map(({ headers: _h, ...rest }) => rest);
          res = await post(stripped);
        } else {
          throw err;
        }
      }

      // Resend returns { data: [{ id }, ...] }
      const ids = (res?.data?.data || []).map((d) => d?.id).filter(Boolean);
      result.ids.push(...ids);
      result.sent += group.length;
    } catch (err) {
      result.failed += group.length;
      const detail =
        err?.response?.data?.message ||
        err?.response?.data?.error ||
        err?.message ||
        "resend batch failed";
      result.errors.push(detail);
      console.error(`[mailer] batch ${i + 1}/${chunks.length} failed:`, detail);
    }
  }

  return result;
}

/** Single send — handy for testing / one-offs. Same retry + pacing. */
export async function sendOne(msg, { idempotencyKey } = {}) {
  const http = client();
  const headers = {};
  if (idempotencyKey)
    headers["Idempotency-Key"] = String(idempotencyKey).slice(0, 256);

  const res = await paced(() =>
    withRetry(() => http.post("/emails", toResendEmail(msg), { headers }), {
      retries: 4,
      baseMs: 800,
      label: "resend:send",
    }),
  );
  return res?.data?.id || null;
}

/** True when Resend is configured — lets the cron skip cleanly in dev. */
export function mailerReady() {
  return Boolean(process.env.RESEND_API_KEY && process.env.PUBLIC_API_URL);
}
