/* ------------------------------------------------------------------ *
 *  retry.js  (NEW — shared, dependency-free)
 *
 *  One place for "call a rate-limited API without falling over".
 *  Used by mailer.js (Resend: ~2 req/s) and sheet.js / monthlySheet.js
 *  (Google Sheets: 60 reads + 60 writes per minute per project).
 *
 *  - withRetry()  : exponential backoff + jitter on 429 / 5xx / network.
 *                   Honours Retry-After when the server sends one.
 *  - createPacer(): a process-wide serial queue that spaces calls out so
 *                   we never *burst* into a rate limit in the first place.
 * ------------------------------------------------------------------ */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True for errors that are worth retrying (transient). */
export function isRetryable(err) {
  // axios-style
  const status = err?.response?.status ?? err?.status ?? err?.code;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500 && status <= 599) return true;

  // googleapis-style (err.code is the HTTP status)
  if (err?.code === 429) return true;
  if (typeof err?.code === "number" && err.code >= 500) return true;

  // network / socket level
  const net = err?.code;
  if (
    net === "ECONNRESET" ||
    net === "ETIMEDOUT" ||
    net === "ECONNABORTED" ||
    net === "EAI_AGAIN" ||
    net === "ENOTFOUND" ||
    net === "EPIPE"
  ) {
    return true;
  }

  // Google sometimes buries it in the message
  const msg = String(err?.message || "");
  if (/rate limit|quota exceeded|too many requests|backend error/i.test(msg)) {
    return true;
  }
  return false;
}

/** Read Retry-After (seconds) from an axios or googleapis error, if present. */
function retryAfterMs(err) {
  const h =
    err?.response?.headers?.["retry-after"] ??
    err?.response?.headers?.["Retry-After"] ??
    err?.headers?.["retry-after"];
  if (!h) return 0;
  const secs = Number(h);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
}

/**
 * Run `fn` with exponential backoff + full jitter.
 * Non-retryable errors are re-thrown immediately (no wasted attempts).
 */
export async function withRetry(
  fn,
  {
    retries = 5,
    baseMs = 500,
    maxMs = 30_000,
    label = "call",
    onRetry = null,
  } = {},
) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!isRetryable(err) || attempt >= retries) throw err;

      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      // Full jitter: pick uniformly in [0, backoff]. Prevents a thundering
      // herd when many orders hit the same 429 at the same moment.
      const jittered = Math.floor(Math.random() * backoff);
      const wait = Math.max(retryAfterMs(err), jittered, baseMs);

      attempt += 1;
      if (onRetry) onRetry(attempt, wait, err);
      else {
        console.warn(
          `[retry] ${label} attempt ${attempt}/${retries} in ${wait}ms — ${err?.message}`,
        );
      }
      await sleep(wait);
    }
  }
}

/**
 * Serial pacer: guarantees at least `minIntervalMs` between calls in this
 * process. Returns a function you wrap around each API call.
 *
 *   const paced = createPacer(600);           // ≈1.6 req/s
 *   await paced(() => axios.post(...));
 */
export function createPacer(minIntervalMs) {
  let chain = Promise.resolve();
  let lastRunAt = 0;

  return function paced(fn) {
    const run = async () => {
      const wait = Math.max(0, lastRunAt + minIntervalMs - Date.now());
      if (wait) await sleep(wait);
      lastRunAt = Date.now();
      return fn();
    };
    // Keep the chain alive even if this call rejects, or the queue dies.
    const next = chain.then(run, run);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}
