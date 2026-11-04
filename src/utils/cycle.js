/* ------------------------------------------------------------------ *
 *  cycle.js   (NEW — the single source of truth for the renewal cycle)
 *
 *  The cycle length used to be duplicated across FOUR files as
 *  `RENEWAL_CYCLE_DAYS = 30`:
 *      cron.js            (findDueRenewals cutoff)
 *      reminderCron.js    (the email window)
 *      order.controller.js (THIRTY_DAYS_MS, twice)
 *  Change one and forget another and the system quietly disagrees with
 *  itself about when a customer is due. So: one module, one definition.
 *
 *  ════════════════════════════════════════════════════════════════════
 *  ⚠ WHY THIS IS CALENDAR MONTHS AND NOT "90 DAYS"
 *  ════════════════════════════════════════════════════════════════════
 *
 *  The requirement is: Jan 1 -> Apr 1 -> Jul 1 -> Oct 1.
 *
 *  Counting 90 days gives you:
 *
 *      Jan 1  +90d ->  Apr 1   ✓   (31+28+31 = 90)
 *      Apr 1  +90d ->  Jun 30  ✗   (30+31+30 = 91 — you're a day short)
 *      Jun 30 +90d ->  Sep 28  ✗
 *      Sep 28 +90d ->  Dec 27  ✗
 *
 *  It drifts BACKWARDS every cycle and never recovers. Within a year the
 *  customer is being shipped on a completely different date than the one
 *  they signed up for.
 *
 *  Adding 3 calendar MONTHS is exact, every time, forever. That is what
 *  "quarterly" means, and it's what this does.
 *
 *  ════════════════════════════════════════════════════════════════════
 *  ⚠ AND WHY THE CLOCK IS "ANCHORED"
 *  ════════════════════════════════════════════════════════════════════
 *
 *  When a renewal completes we do NOT set lastRenewAt = now(). If the cron
 *  runs at 00:04 on Apr 1, `now` is Apr 1 00:04 — and next quarter becomes
 *  Jul 1 00:04, then Oct 1 00:08... each late run pushes the schedule
 *  further out. Over a year that's real drift.
 *
 *  Instead we advance to the SCHEDULED date: cycleDate + 3 months. The
 *  customer stays on the 1st forever, no matter when the cron actually
 *  fires.
 *
 *  ...and if the cron has been DOWN for two whole quarters, we jump to the
 *  most recent scheduled date rather than shipping a backlog of orders.
 *  One outage should not mean three parcels on the doorstep.
 * ------------------------------------------------------------------ */

/** Quarterly. Set RENEWAL_CYCLE_MONTHS=1 to go back to monthly. */
export const CYCLE_MONTHS = Number(process.env.RENEWAL_CYCLE_MONTHS || 3);

/** Send the reminder email this many days BEFORE the next shipment. */
export const REMINDER_BEFORE_DAYS = Number(
  process.env.REMINDER_BEFORE_DAYS || 15,
);

/** How long an address is blocked from ordering again. Defaults to the
 *  cycle length — one shipment per household per cycle. */
export const DEDUPE_MONTHS = Number(
  process.env.ORDER_DEDUPE_MONTHS || CYCLE_MONTHS,
);

export const DAY_MS = 24 * 60 * 60 * 1000;

/* ================================================================== *
 *  ⚠ DO NOT RENAME `subscription: "monthly"` TO "quarterly".
 *
 *  That string is load-bearing in 16 places across the codebase, plus the
 *  WordPress form, plus every existing document in the database. To rename
 *  it you would have to change ALL of them, migrate every row, and deploy
 *  WordPress and the backend in lockstep. Miss ONE and those subscribers
 *  silently vanish from the cron's filter — no error, they just stop
 *  shipping, and nobody notices for three months.
 *
 *  So instead: ACCEPT BOTH. The value means "recurring"; the CADENCE is
 *  RENEWAL_CYCLE_MONTHS. Existing "monthly" rows keep working untouched,
 *  and WordPress can start sending "quarterly" whenever you like — no
 *  migration, no coordinated deploy, no downtime.
 * ================================================================== */
export const RECURRING = ["monthly", "quarterly", "recurring"];

/** What we WRITE when we create/restore a subscription. Keeps existing
 *  data consistent — but reads accept any of RECURRING. */
export const RECURRING_CANONICAL = "monthly";

/** Is this subscription value a recurring one (i.e. not one_time)? */
export const isRecurring = (sub) => RECURRING.includes(String(sub || ""));

/** For Mongo queries: { subscription: RECURRING_MATCH } */
export const RECURRING_MATCH = { $in: RECURRING };

/**
 * Add N calendar months, in UTC.
 *
 * Month-end is clamped, which is the only sane behaviour:
 *     Jan 31 + 1 month -> Feb 28   (not Mar 3)
 *     Aug 31 + 1 month -> Sep 30
 *
 * JS's setUTCMonth() overflows instead (Jan 31 -> Mar 3), so we clamp by
 * hand. Someone who subscribes on the 31st should be renewed on the last
 * day of the month, not bounced into the next one.
 */
export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();

  // Move to the 1st first, so the month shift can't overflow.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);

  // Clamp the day to the last valid day of the target month.
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));

  return d;
}

/* ++ CLIENT RULE (final) ++  SHIPMENTS LAND ON THE 1st.
 *
 *   "if they ordered june 17, they will receive the next october 1st
 *    then jan 1st then april 1st"
 *
 * Rule: next shipment = renewAt + CYCLE_MONTHS calendar months, ROUNDED
 * UP to the 1st of the following month — unless it already lands on a
 * 1st, in which case it stays.
 *
 *     Jun 17 + 3mo = Sep 17  -> Oct 1     (first renewal snaps)
 *     Oct  1 + 3mo = Jan  1  -> Jan 1     (already a 1st — stays)
 *                            -> Apr 1, Jul 1, ...
 *
 * Consequences, all intended:
 *   - nobody is ever shipped sooner than CYCLE_MONTHS FULL months;
 *   - after the first renewal every subscriber is on a 1st-of-month
 *     schedule, quarterly thereafter;
 *   - reminderAt follows automatically (dueAt - REMINDER_BEFORE_DAYS),
 *     so reminders go out mid-month before each 1st.
 *
 * RENEWAL_SNAP_TO_FIRST=false restores plain anniversary dates. */
export const SNAP_TO_FIRST = process.env.RENEWAL_SNAP_TO_FIRST !== "false";

/** Round a date UP to the 1st of the next month, unless it IS a 1st. */
export function roundUpToFirst(date) {
  const d = new Date(date);
  if (d.getUTCDate() === 1) return d;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/* ================================================================== *
 *  PER-SITE CYCLE RULES
 *
 *   LA    -> unchanged: CYCLE_MONTHS calendar months, snapped to the
 *            1st, reminder REMINDER_BEFORE_DAYS before.
 *   WEHO  -> every WEHO_CYCLE_DAYS days (default 30), no snapping,
 *            reminder WEHO_REMINDER_BEFORE_DAYS (default 15) before.
 *
 *  Site comes from order.source. Only "Defent La" is LA; everything
 *  else (incl. legacy null / "" / "weho") is WEHO — the same rule the
 *  rest of the codebase uses for `flag`.
 *
 *  Every function below takes `site` LAST and defaults to LA, so a
 *  caller that doesn't pass one gets exactly the old behaviour.
 *  Always pass siteOf(order) — never order.source directly, because an
 *  undefined source would fall into the LA default.
 * ================================================================== */
export const SITE_LA = "la";
export const SITE_WEHO = "weho";
export const LA_SOURCE = "Defent La";

export const WEHO_CYCLE_DAYS = Number(process.env.WEHO_CYCLE_DAYS || 30);
export const WEHO_REMINDER_BEFORE_DAYS = Number(
  process.env.WEHO_REMINDER_BEFORE_DAYS || 15,
);

/** "la" | "weho" from an order doc, or from a source string. */
export function siteOf(orderOrSource) {
  const src =
    typeof orderOrSource === "string" ? orderOrSource : orderOrSource?.source;
  return src === LA_SOURCE ? SITE_LA : SITE_WEHO;
}

const reminderDaysFor = (site) =>
  site === SITE_WEHO ? WEHO_REMINDER_BEFORE_DAYS : REMINDER_BEFORE_DAYS;

/** Midnight UTC of the given date (the cycle key's day). */
const startOfUTCDay = (date) => {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

/** The date a subscription that last renewed at `renewAt` is next due. */
export function nextDueAt(renewAt, site = SITE_LA) {
  if (site === SITE_WEHO) {
    /* Counted from the start of the cycle-key day, so the JS check and
       the Mongo dueAtExpr() below agree to the millisecond. */
    return new Date(
      startOfUTCDay(renewAt).getTime() + WEHO_CYCLE_DAYS * DAY_MS,
    );
  }
  const base = addMonths(new Date(renewAt), CYCLE_MONTHS);
  return SNAP_TO_FIRST ? roundUpToFirst(base) : base;
}

/** Is this subscription due for a shipment? */
export function isDue(renewAt, now = Date.now(), site = SITE_LA) {
  return nextDueAt(renewAt, site).getTime() <= now;
}

/** When should the reminder email go out for this cycle? */
export function reminderAt(renewAt, site = SITE_LA) {
  return new Date(
    nextDueAt(renewAt, site).getTime() - reminderDaysFor(site) * DAY_MS,
  );
}

/* ------------------------------------------------------------------ *
 *  Mongo versions of nextDueAt / reminderAt, for aggregation pipelines.
 *  Both crons MUST use these so they can never disagree with the JS
 *  isDue() check in createOrder (a disagreement = a 409 loop).
 *  The LA branch is the exact expression cron.js used before.
 * ------------------------------------------------------------------ */
export function dueAtExpr(renewAt = "$renewAt") {
  const laBase = {
    $dateAdd: { startDate: renewAt, unit: "month", amount: CYCLE_MONTHS },
  };
  const la = SNAP_TO_FIRST
    ? {
        $cond: [
          { $eq: [{ $dayOfMonth: laBase }, 1] },
          laBase,
          {
            $dateAdd: {
              startDate: { $dateTrunc: { date: laBase, unit: "month" } },
              unit: "month",
              amount: 1,
            },
          },
        ],
      }
    : laBase;

  const weho = {
    $dateAdd: {
      startDate: { $dateTrunc: { date: renewAt, unit: "day" } },
      unit: "day",
      amount: WEHO_CYCLE_DAYS,
    },
  };

  return { $cond: [{ $eq: ["$source", LA_SOURCE] }, la, weho] };
}

export function remindAtExpr(dueAt = "$dueAt") {
  return {
    $dateSubtract: {
      startDate: dueAt,
      unit: "day",
      amount: {
        $cond: [
          { $eq: ["$source", LA_SOURCE] },
          REMINDER_BEFORE_DAYS,
          WEHO_REMINDER_BEFORE_DAYS,
        ],
      },
    },
  };
}

/** Household block for an ACTIVE recurring order at an address. */
export function recurringDedupeUntil(renewRef, site = SITE_LA) {
  if (site === SITE_WEHO) {
    return new Date(new Date(renewRef).getTime() + WEHO_CYCLE_DAYS * DAY_MS);
  }
  return addMonths(new Date(renewRef), DEDUPE_MONTHS);
}

/** "monthly" / "quarterly" / ... for email copy. */
export function cycleWordFor(site = SITE_LA) {
  if (site === SITE_WEHO) {
    return WEHO_CYCLE_DAYS === 30 ? "monthly" : `every-${WEHO_CYCLE_DAYS}-days`;
  }
  return CYCLE_MONTHS === 1
    ? "monthly"
    : CYCLE_MONTHS === 3
      ? "quarterly"
      : `every-${CYCLE_MONTHS}-months`;
}

/**
 * Where lastRenewAt should land after a renewal completes.
 *
 * ANCHORED to the schedule, not to wall-clock `now`:
 *     cycleDate Jan 1, cron fires Apr 1 00:04  -> Apr 1   (not Apr 1 00:04)
 *     cycleDate Jan 1, cron fires Apr 8 (late) -> Apr 1   (no drift)
 *
 * CATCH-UP IS CAPPED. If the cron was down for two quarters:
 *     cycleDate Jan 1, cron fires Aug 1 -> Jul 1   (NOT Apr 1)
 * ...so the next run doesn't immediately fire again and ship a backlog.
 * One outage, one parcel.
 */
export function nextAnchor(cycleDate, now = Date.now(), site = SITE_LA) {
  /* Step along the SAME schedule nextDueAt() defines — with snapping on,
     the first step lands on a 1st and every later step stays on 1sts
     (a 1st + 3 months is a 1st, and roundUpToFirst leaves it alone).
     WEHO steps in WEHO_CYCLE_DAYS increments. */
  let d = nextDueAt(new Date(cycleDate), site);
  // Skip whole cycles that were missed entirely.
  while (nextDueAt(d, site).getTime() <= now) {
    d = nextDueAt(d, site);
  }
  return d;
}

/** The cycle key. UNCHANGED — still the ISO date we're renewing FROM. */
export const cycleKeyFor = (order) =>
  new Date(order.lastRenewAt ?? order.createdAt ?? Date.now())
    .toISOString()
    .slice(0, 10);

/** Days from now until the next shipment (for the email copy). */
export function daysUntilDue(renewAt, now = Date.now(), site = SITE_LA) {
  return Math.max(
    0,
    Math.ceil((nextDueAt(renewAt, site).getTime() - now) / DAY_MS),
  );
}

/** Human summary for the boot banner. */
export function cycleSummary() {
  const label =
    CYCLE_MONTHS === 1
      ? "monthly"
      : CYCLE_MONTHS === 3
        ? "quarterly"
        : `every ${CYCLE_MONTHS} months`;
  return (
    `LA ${label} (+${CYCLE_MONTHS} calendar month${CYCLE_MONTHS === 1 ? "" : "s"}), reminder ${REMINDER_BEFORE_DAYS}d before; ` +
    `WEHO every ${WEHO_CYCLE_DAYS}d, reminder ${WEHO_REMINDER_BEFORE_DAYS}d before`
  );
}
