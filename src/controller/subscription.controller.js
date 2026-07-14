/* ------------------------------------------------------------------ *
 *  subscription.controller.js  (NEW)
 *
 *  The unsubscribe endpoint the 15-day email links to.
 *
 *  ⚠ THE MOST IMPORTANT DESIGN DECISION IN THIS FILE ⚠
 *  ─────────────────────────────────────────────────────────────────
 *  GET does NOT cancel anything. It only renders a confirmation page.
 *  POST is what cancels.
 *
 *  Why: Gmail, Outlook, and virtually every corporate mail-security
 *  gateway PRE-FETCH every link in an inbound email to scan it. If GET
 *  mutated state, a large slice of subscribers would be silently
 *  unsubscribed by a robot that merely *looked* at their mail — and we'd
 *  never know why the renewals dried up. This bites people constantly.
 *
 *  We still support true one-click unsubscribe: the email carries
 *  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), so the
 *  native "Unsubscribe" button in Gmail POSTs here directly — and POST is
 *  exactly the verb that cancels. Scanners GET; humans and RFC-8058
 *  clients POST. Both are correct.
 *
 *  CANCELLING == "make them a one-time customer":
 *      subscription -> "one_time"
 *      isActive     -> false
 *      isRenewable  -> false
 *  which is precisely the predicate findDueRenewals() filters on, so they
 *  drop out of every future renewal AND every future reminder. No new
 *  moving parts, no separate "cancelled" flag to keep in sync.
 * ------------------------------------------------------------------ */

import { OrderModel, ReminderLogModel } from "../model/orderModel.js";
import {
  RECURRING_MATCH,
  isRecurring,
  nextDueAt,
  reminderAt,
} from "../utils/cycle.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { verifyUnsubToken } from "../utils/unsubscribeToken.js";
import { unsubConfirmPage, unsubResultPage } from "../utils/emailTemplates.js";
import { ErrorLogModel } from "../model/errorLog.js";

const logQuietly = async (payload) => {
  try {
    await ErrorLogModel.create({
      source: "orders-backend",
      module: "unsubscribe",
      resolved: false,
      ...payload,
    });
  } catch (e) {
    console.error("[unsub] error log failed:", e?.message);
  }
};

const html = (res, code, body) =>
  res.status(code).set("Content-Type", "text/html; charset=utf-8").send(body);

const FAILED = {
  malformed:
    "That link doesn't look right. It may have been cut in half by your email app — try copying the full link from the message.",
  bad_signature:
    "That link isn't valid. It may have been altered or copied incorrectly.",
  expired:
    "That link has expired. Please contact us and we'll cancel your monthly shipments for you.",
  misconfigured:
    "We're unable to process this right now. Please contact us and we'll help.",
};

/* ================================================================== *
 *  GET /api/v1/subscription/unsubscribe?t=<token>
 *  Renders the confirmation page. Mutates NOTHING.
 * ================================================================== */
export const getUnsubscribe = asyncHandler(async (req, res) => {
  const token = req?.query?.t || "";
  const v = verifyUnsubToken(token);

  if (!v.ok) {
    return html(
      res,
      v.reason === "expired" ? 410 : 400,
      unsubResultPage({
        title: "This link can't be used",
        body: FAILED[v.reason] || FAILED.malformed,
        tone: "error",
      }),
    );
  }

  const order = await OrderModel.findById(v.orderId)
    .select("firstName subscription isActive isRenewable unsubscribedAt")
    .lean();

  if (!order) {
    return html(
      res,
      404,
      unsubResultPage({
        title: "We couldn't find that subscription",
        body: "It may already have been removed. If you're still receiving shipments you don't want, please contact us.",
        tone: "error",
      }),
    );
  }

  // Already cancelled -> show the "you're all set" page, no button.
  const active =
    isRecurring(order.subscription) && order.isActive && order.isRenewable;

  return html(
    res,
    200,
    unsubConfirmPage({
      token,
      firstName: order.firstName,
      alreadyCancelled: !active,
    }),
  );
});

/* ================================================================== *
 *  POST /api/v1/subscription/unsubscribe
 *  body: { t: <token> }   (form-encoded from our page, or JSON, or the
 *                          RFC-8058 one-click POST from Gmail)
 *
 *  IDEMPOTENT: posting twice is harmless — the second call finds them
 *  already cancelled and reports success without touching anything.
 * ================================================================== */
export const postUnsubscribe = asyncHandler(async (req, res) => {
  // Accept the token from body (our form / one-click) or query (fallback).
  const token = req?.body?.t || req?.body?.token || req?.query?.t || "";

  // Gmail's one-click POST sends `List-Unsubscribe=One-Click` as the body
  // and expects a 2xx. It won't render HTML, so we answer JSON for it.
  const wantsJson =
    req.get("accept")?.includes("application/json") ||
    req.get("content-type")?.includes("application/json") ||
    "List-Unsubscribe" in (req.body || {});

  const v = verifyUnsubToken(token);
  if (!v.ok) {
    await logQuietly({
      stage: "token_invalid",
      level: "warning",
      message: `Unsubscribe token rejected: ${v.reason}`,
      statusCode: 400,
    });
    if (wantsJson) {
      return res
        .status(400)
        .json(new ApiResponse(400, null, `Invalid link (${v.reason})`));
    }
    return html(
      res,
      v.reason === "expired" ? 410 : 400,
      unsubResultPage({
        title: "This link can't be used",
        body: FAILED[v.reason] || FAILED.malformed,
        tone: "error",
      }),
    );
  }

  const now = new Date();

  /* ---- THE CANCEL ----
     One atomic conditional update. The filter requires them to still be
     an active monthly subscriber, so:
       - concurrent double-POST  -> only the first matches; second is a
                                    no-op that reports "already cancelled"
       - a renewal racing us     -> whoever lands first wins cleanly; we
                                    never half-apply the change            */
  const updated = await OrderModel.findOneAndUpdate(
    {
      _id: v.orderId,
      subscription: RECURRING_MATCH,
      isActive: true,
      isRenewable: true,
    },
    {
      $set: {
        subscription: "one_time", // <- becomes a one-time customer
        isActive: false,
        isRenewable: false,
        unsubscribedAt: now,
        unsubscribeSource: wantsJson ? "one_click" : "email_link",
        // no more shipments -> no next date
        nextOrderAt: null,
        nextReminderAt: null,
      },
    },
    { new: true },
  );

  if (!updated) {
    // Either already cancelled, or the order id no longer exists.
    const exists = await OrderModel.exists({ _id: v.orderId });
    if (!exists) {
      if (wantsJson) {
        return res
          .status(404)
          .json(new ApiResponse(404, null, "Subscription not found"));
      }
      return html(
        res,
        404,
        unsubResultPage({
          title: "We couldn't find that subscription",
          body: "It may already have been removed. If you're still receiving shipments you don't want, please contact us.",
          tone: "error",
        }),
      );
    }

    if (wantsJson) {
      return res
        .status(200)
        .json(
          new ApiResponse(
            200,
            { orderId: v.orderId, alreadyCancelled: true },
            "Already unsubscribed",
          ),
        );
    }
    return html(
      res,
      200,
      unsubResultPage({
        title: "You're already unsubscribed",
        body: "Your monthly shipments were already cancelled — there's nothing more to do.",
        tone: "ok",
      }),
    );
  }

  // Stop any reminder still queued for this cycle from going out.
  await ReminderLogModel.updateMany(
    { orderId: v.orderId, status: { $in: ["processing", "failed"] } },
    { $set: { status: "failed", lastError: "customer unsubscribed" } },
  );

  console.log(
    `[unsub] cancelled orderId=${v.orderId} cycle=${v.cycle} src=${updated.unsubscribeSource}`,
  );

  if (wantsJson) {
    return res
      .status(200)
      .json(
        new ApiResponse(
          200,
          { orderId: v.orderId, cancelled: true },
          "Monthly shipments cancelled",
        ),
      );
  }

  return html(
    res,
    200,
    unsubResultPage({
      title: "Your monthly shipments are cancelled",
      body: "You won't receive any further DEFENT ONE shipments. Anything already on its way will still arrive, and you're welcome to sign up again any time.",
      tone: "ok",
    }),
  );
});

/* ================================================================== *
 *  POST /api/v1/subscription/resubscribe   (admin / support escape hatch)
 *  body: { orderId }
 * ================================================================== */
export const resubscribe = asyncHandler(async (req, res) => {
  const { orderId } = req?.body || {};
  if (!orderId) {
    return res.status(400).json(new ApiResponse(400, null, "orderId required"));
  }

  const order = await OrderModel.findOneAndUpdate(
    { _id: orderId },
    {
      $set: {
        subscription: RECURRING_MATCH,
        isActive: true,
        isRenewable: true,
        unsubscribedAt: null,
        unsubscribeSource: "",
        // Restart the clock so they don't get renewed the instant they
        // re-enrol (their old lastRenewAt could be a whole cycle stale).
        lastRenewAt: new Date(),
        nextOrderAt: nextDueAt(new Date()),
        nextReminderAt: reminderAt(new Date()),
      },
    },
    { new: true },
  );

  if (!order) {
    return res.status(404).json(new ApiResponse(404, null, "Order not found"));
  }

  return res
    .status(200)
    .json(new ApiResponse(200, order, "Monthly subscription re-enabled"));
});
