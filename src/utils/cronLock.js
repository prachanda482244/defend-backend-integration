/* ------------------------------------------------------------------ *
 *  cronLock.js  (NEW — extracted from cron.js so every job shares ONE
 *  correct implementation instead of three copy-pasted ones)
 *
 *  Lease-based mutex on a single Mongo doc. Render/Railway/Heroku can run
 *  >1 instance, restart mid-run, or overlap a slow run with the next
 *  tick — any of which would otherwise let two workers process the same
 *  subscription and produce TWO Shopify orders / TWO emails.
 *
 *  Lease semantics: a lock auto-expires after ttlMs, so a worker that
 *  dies mid-run can't wedge the job forever.
 * ------------------------------------------------------------------ */

import { CronLockModel } from "../model/orderModel.js";

/* ------------------------------------------------------------------ *
 *  ⚠ THE HOLDER MUST IDENTIFY THE *PROCESS*, NOT THE MACHINE.
 *
 *  It used to be just the hostname. On one machine that means every
 *  process — the dead one from your last Ctrl+C AND the live one running
 *  right now — has the SAME holder. So `holder === HOLDER` could not tell
 *  "a previous process died" apart from "my own run is still going", and
 *  the skip message confidently accused a perfectly healthy in-progress
 *  run of being a corpse.
 *
 *  Adding the pid makes each process distinguishable:
 *      DESKTOP-GT1HAPE#18244   <- the run that is happening NOW
 *      DESKTOP-GT1HAPE#17901   <- the one you killed
 * ------------------------------------------------------------------ */
const HOST = process.env.RENDER_INSTANCE_ID || process.env.HOSTNAME || "worker";
const HOLDER = `${HOST}#${process.pid}`;

/** Was this lock taken by a DIFFERENT process on THIS machine? (i.e. dead) */
const isDeadSibling = (holder) =>
  typeof holder === "string" &&
  holder.startsWith(`${HOST}#`) &&
  holder !== HOLDER;

/**
 * Try to take the lock. Returns true only for the ONE winner.
 *
 * The filter `{ lockedUntil: { $lt: now } }` matches only if no live lease
 * exists. With upsert:true, a losing racer tries to INSERT and trips the
 * unique index on `name` -> E11000 -> we return false. That duplicate-key
 * error IS the mutex.
 */
export async function acquireLock(name, ttlMs) {
  const now = new Date();
  const until = new Date(now.getTime() + ttlMs);
  try {
    const res = await CronLockModel.findOneAndUpdate(
      { name, lockedUntil: { $lt: now } },
      { $set: { lockedUntil: until, holder: HOLDER } },
      { upsert: true, new: true },
    );
    return Boolean(res);
  } catch (e) {
    if (e?.code === 11000) return false; // someone else holds a live lease
    throw e;
  }
}

/** Release early so the next tick isn't blocked for the full TTL. */
export async function releaseLock(name) {
  try {
    await CronLockModel.updateOne(
      { name },
      { $set: { lockedUntil: new Date(0) } },
    );
  } catch (e) {
    console.error(`[cron] lock release failed (${name}):`, e?.message);
  }
}

/* ------------------------------------------------------------------ *
 *  ++ NEW ++  LEASE HEARTBEAT
 *
 *  The TTL is a bet: "this run will finish within 30 minutes." If the run
 *  takes LONGER, the lease expires WHILE THE RUN IS STILL GOING, and the
 *  next tick happily starts a second, concurrent run of the same job.
 *
 *  That bet gets lost easily. On a dev store you have to pace at ~15s per
 *  order to stay under the order-creation cap:
 *
 *      300 subscribers x 700ms   (prod pacing) = ~10 min  <  30m TTL  ✓
 *      300 subscribers x 15000ms (dev  pacing) = ~85 min  >  30m TTL  ✗
 *
 *  So instead of betting, we EXTEND the lease every TTL/3 for as long as
 *  the job is actually running. A live run keeps its lock forever; a DEAD
 *  process stops heartbeating, so its lease still expires on its own and
 *  the job self-heals. Both properties preserved.
 * ------------------------------------------------------------------ */
function startHeartbeat(name, ttlMs) {
  const everyMs = Math.max(5_000, Math.floor(ttlMs / 3));

  const timer = setInterval(async () => {
    try {
      const res = await CronLockModel.updateOne(
        { name, holder: HOLDER }, // only extend a lock we still own
        { $set: { lockedUntil: new Date(Date.now() + ttlMs) } },
      );
      if (!res.matchedCount) {
        // Someone else took it — we lost the lease. Stop pretending.
        console.warn(`[cron:${name}] lost the lease (another holder took it)`);
        clearInterval(timer);
      }
    } catch (e) {
      console.error(`[cron:${name}] heartbeat failed:`, e?.message);
    }
  }, everyMs);

  // Don't hold the event loop open just for a heartbeat.
  timer.unref?.();
  return timer;
}

/** Run `fn` only if we win the lock. Always releases, even on throw. */
/* ++ Runs ONCE, lazily, on the first lock attempt of this process. ++
 *
 * This used to live in index.js. That was fragile: if index.js wasn't
 * updated (or nodemon restarted before it fired), dead locks were never
 * cleared and every tick just logged "held by a DEAD process" for the next
 * 30 minutes. A lock that can only be cleaned by a DIFFERENT file is not a
 * self-healing lock. Now it cleans itself. */
let bootCleanupDone = false;
async function ensureBootCleanup() {
  if (bootCleanupDone) return;
  bootCleanupDone = true;
  await releaseOwnStaleLocks();
}

export async function withLock(name, ttlMs, fn) {
  await ensureBootCleanup();
  const got = await acquireLock(name, ttlMs);

  if (!got) {
    /* ++ Say something USEFUL. "another run holds the lock" tells you nothing
       about whether that run is ALIVE or a CORPSE left by a restart. */
    const held = await CronLockModel.findOne({ name }).lean();
    const mins = held?.lockedUntil
      ? Math.max(0, Math.round((held.lockedUntil - Date.now()) / 60000))
      : "?";

    if (held?.holder === HOLDER) {
      /* OUR OWN run, still going. Completely healthy — this is the lock
         doing exactly its job: stopping the next tick from starting a
         second, overlapping run. Nothing to fix. */
      console.log(
        `[cron:${name}] our own run is still in progress — skipping this tick. (normal)`,
      );
    } else if (isDeadSibling(held?.holder)) {
      console.log(
        `[cron:${name}] held by a DEAD process (${held.holder}) for another ${mins} min — skipping.` +
          `  ⚠ It died without releasing. Restart clears this automatically;` +
          `  or:  db.cronlocks.deleteMany({})`,
      );
    } else {
      console.log(
        `[cron:${name}] held by another instance "${held?.holder || "?"}" for another ${mins} min — skipping.`,
      );
    }
    return { skipped: true };
  }

  /* Keep the lease alive for as long as the job actually runs, so a slow
     batch can't have its lock expire out from under it. */
  const beat = startHeartbeat(name, ttlMs);
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    await releaseLock(name);
  }
}

/* ------------------------------------------------------------------ *
 *  ++ NEW ++  releaseOwnStaleLocks() — call once at startup.
 *
 *  ── THE RESTART TRAP ────────────────────────────────────────────────
 *  withLock() releases in a `finally`. But Ctrl+C, a container kill, or
 *  nodemon restarting on a file save SKIPS the finally — so the lease
 *  survives in Mongo. Until it expires (THIRTY MINUTES for renewals)
 *  every tick logs "another run holds the lock — skipping" and nothing
 *  runs. In dev, where you restart constantly, that looks exactly like a
 *  broken cron.
 *
 *  A lock still held by OUR holder id means the process that took it is
 *  gone — we replaced it. That lease is a corpse; safe to clear.
 *
 *  Locks held by a DIFFERENT holder are left ALONE. That could be a live
 *  sibling instance mid-run, and stealing its lock is precisely how you
 *  end up with two Shopify orders for the same subscription.
 * ------------------------------------------------------------------ */
export async function releaseOwnStaleLocks() {
  try {
    /* Live locks held by some OTHER process on THIS machine. Since we're
       booting, any earlier process of ours is gone — its lease is a corpse.
       We do NOT touch locks from other hosts: those may be a live sibling
       instance mid-run, and stealing its lock is exactly how you'd get two
       Shopify orders for the same subscription. */
    const all = await CronLockModel.find({
      lockedUntil: { $gt: new Date() },
    }).lean();

    const dead = all.filter((l) => isDeadSibling(l.holder));
    if (!dead.length) return 0;

    await CronLockModel.updateMany(
      { _id: { $in: dead.map((d) => d._id) } },
      { $set: { lockedUntil: new Date(0) } },
    );

    console.log(
      `[cron] cleared ${dead.length} lock(s) left by a dead process: ` +
        dead.map((d) => `${d.name} (${d.holder})`).join(", "),
    );
    return dead.length;
  } catch (e) {
    console.error("[cron] stale-lock cleanup failed:", e?.message);
    return 0;
  }
}
