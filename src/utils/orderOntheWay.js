/* ------------------------------------------------------------------ *
 *  orderOnTheWay.js  (NEW)
 *
 *  Sends the "Your quarterly order #4232 is on the way" email the
 *  moment a Shopify order is CONFIRMED (first-time or renewal).
 
 *  Exactly-once, twice over:
 *    1. The CALLER only invokes this on the first transition to synced
 *       (renewals: advancePastCycle() returned true; first orders: the
 *       pre-image was not yet synced).
 *    2. The Resend idempotency key `otw:<orderId>:<cycle>` de-dupes for
 *       24h even if (1) somehow fires twice (crash between send and
 *       DB write, double-delivered confirm, etc).
 *
 *  This function NEVER throws — an email problem must not fail a
 *  confirm, which would send the reconciler chasing a Shopify order
 *  that succeeded. It returns { sent, skipped?, error? } and the
 *  caller decides what to log.
 * ------------------------------------------------------------------ */

import { sendOne, mailerReady } from "./mailer.js";
import { buildUnsubUrl } from "./unsubscribeToken.js";
import { orderOnTheWayEmail } from "./emailTemplates.js";
import { CYCLE_MONTHS, isRecurring, nextDueAt } from "./cycle.js";

/* Kill switch, on by default. Set ORDER_EMAIL_ENABLED=false to silence
   the shipment email without a deploy. */
const ENABLED = process.env.ORDER_EMAIL_ENABLED !== "false";

const cycleWord = () =>
  CYCLE_MONTHS === 1
    ? "monthly"
    : CYCLE_MONTHS === 3
      ? "quarterly"
      : `every-${CYCLE_MONTHS}-months`;

/**
 * @param {object} order   the Mongo order document (lean is fine)
 * @param {object} opts    { orderName, cycle }
 *   orderName — Shopify's human order number ("#4232"). May be missing
 *               on healed orders; the template degrades gracefully.
 *   cycle     — renewal cycle key, or "first" for a first order.
 */
export async function sendOrderOnTheWay(
  order,
  { orderName = "", cycle = "first" } = {},
) {
  try {
    if (!ENABLED) return { sent: false, skipped: "disabled" };
    if (!order?.email) return { sent: false, skipped: "no email" };
    if (!mailerReady())
      return { sent: false, skipped: "mailer not configured" };

    const recurring =
      isRecurring(order.subscription) && order.isActive !== false;

    /* Cancel link only makes sense for an active subscription — and
       buildUnsubUrl throws without PUBLIC_API_URL, so guard it. */
    let unsubUrl = null;
    if (recurring && order.isRenewable !== false) {
      try {
        unsubUrl = buildUnsubUrl({ orderId: order._id, cycle });
      } catch {
        unsubUrl = null; // PUBLIC_API_URL unset — send without the button
      }
    }

    const shipToLine = [order.streetAddress, order.streetAddress2]
      .filter(Boolean)
      .join(", ");

    const { subject, html, text } = orderOnTheWayEmail({
      firstName: order.firstName,
      source: order.source,
      orderNumber: orderName,
      shipToLine,
      nextRenewalDate: recurring
        ? nextDueAt(order.lastRenewAt || order.createdAt)
        : null,
      unsubUrl,
      cycleWord: recurring ? cycleWord() : "one-time",
    });

    await sendOne(
      { to: order.email, subject, html, text, unsubUrl },
      { idempotencyKey: `otw:${order._id}:${cycle}` },
    );

    return { sent: true };
  } catch (e) {
    return { sent: false, error: e?.message || String(e) };
  }
}
