/* ------------------------------------------------------------------ *
 *  scripts/fix-bad-productids.mjs
 *
 *  Dry run:   node scripts/fix-bad-productids.mjs
 *  Fix them:  node scripts/fix-bad-productids.mjs --fix
 *
 *  Finds orders whose productId Shopify can never accept. These fail with:
 *
 *      400  { errors: { id: "expected String to be a id" } }
 *
 *  ...because gidToNumeric("PROD_001") is NaN, so we request
 *  GET /products/NaN.json. It's a PERMANENT failure — the reconciler will
 *  burn all 6 attempts on it and then give up. Worth cleaning out.
 *
 *  Also flags LA orders carrying the WEHO product id (and vice versa) —
 *  those 404 because the product doesn't exist on that store.
 * ------------------------------------------------------------------ */
import mongoose from "mongoose";
/* ---- run from ANYWHERE: project root, scripts/, doesn't matter ---- */
import "dotenv/config";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

function findBackendModule(rel) {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(dir, "src", ...rel);
    if (existsSync(p)) return pathToFileURL(p).href;
    dir = dirname(dir);
  }
  console.error(
    `\n  ✗ Could not find src/${rel.join("/")}\n` +
      `    Run this from inside the backend project (the folder with src/ and package.json).\n`,
  );
  process.exit(1);
}

const MODELS = await import(findBackendModule(["model", "orderModel.js"]));
const { OrderModel, RenewalLogModel } = MODELS;

const FIX = process.argv.includes("--fix");

/* The real product ids. CHANGE THESE if yours differ. */
const PRODUCT_LA =
  process.env.PRODUCT_ID_LA || "gid://shopify/Product/8660710621356";
const PRODUCT_WEHO =
  process.env.PRODUCT_ID_WEHO || "gid://shopify/Product/8442746437829";

/* Exactly the parse CreateOrderREST does. */
const gidToNumeric = (id) =>
  Number((String(id).match(/\/(\d+)$/) || [])[1] || id);
const isValid = (id) => {
  const n = gidToNumeric(id);
  return Number.isFinite(n) && n > 0;
};

await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017");

const orders = await OrderModel.find({})
  .select(
    "firstName lastName email productId source shopifyOrderId shopifySync createdAt",
  )
  .sort({ createdAt: 1 })
  .lean();

const broken = [];
const mismatched = [];

for (const o of orders) {
  const isLA = o.source === "Defent La";
  const want = isLA ? PRODUCT_LA : PRODUCT_WEHO;

  if (!isValid(o.productId)) {
    broken.push({
      o,
      want,
      why: "not a Shopify id -> GET /products/NaN.json -> 400",
    });
  } else if (o.productId !== want) {
    mismatched.push({
      o,
      want,
      why: `${isLA ? "LA" : "WEHO"} order carrying the ${isLA ? "WEHO" : "LA"} product -> 404 on that store`,
    });
  }
}

const row = (x) =>
  `  ${String(x.o._id)}  ${`${x.o.firstName} ${x.o.lastName}`.slice(0, 18).padEnd(20)}` +
  `${(x.o.source || "").padEnd(12)}${String(x.o.productId).padEnd(38)}` +
  `synced=${x.o.shopifyOrderId ? "yes" : "NO "}  attempts=${x.o.shopifySync?.attempts ?? 0}`;

console.log(`\n═══ ${broken.length} order(s) with an INVALID productId ═══`);
if (broken.length) {
  broken.forEach((x) => console.log(row(x)));
  console.log(`\n  why: ${broken[0].why}`);
} else console.log("  none ✓");

console.log(
  `\n═══ ${mismatched.length} order(s) with the WRONG STORE's product ═══`,
);
if (mismatched.length) {
  mismatched.forEach((x) => console.log(row(x)));
  console.log(`\n  why: ${mismatched[0].why}`);
} else console.log("  none ✓");

const all = [...broken, ...mismatched];
const unsynced = all.filter((x) => !x.o.shopifyOrderId);

console.log(
  `\n  ${all.length} bad total, ${unsynced.length} of which never reached Shopify ` +
    `(those are the ones the reconciler keeps retrying and failing on).`,
);

if (!FIX) {
  console.log(
    `\n  Dry run. To repair them:  node scripts/fix-bad-productids.mjs --fix`,
  );
  console.log(`  (sets productId to the right one for each order's source)`);
  console.log(`\n  Or, if they're just junk test rows, delete them:`);
  console.log(
    `      db.orders.deleteMany({ _id: { $in: [${unsynced
      .slice(0, 3)
      .map((x) => `ObjectId("${x.o._id}")`)
      .join(", ")}${unsynced.length > 3 ? ", …" : ""}] } })\n`,
  );
  await mongoose.disconnect();
  process.exit(0);
}

/* ---- repair ---- */
let fixedProduct = 0;
let requeued = 0;
let logsReset = 0;

for (const x of all) {
  const update = { productId: x.want };

  /* ⚠ THE BUG THIS SCRIPT USED TO HAVE:
   *
   *     if (x.o.shopifyOrderId) continue;   // skip already-synced orders
   *
   * I wrote that thinking "don't rewrite history". Wrong. `productId` on the
   * ORDER document is not history — it is the TEMPLATE for every FUTURE
   * renewal. An order whose first-time Shopify order succeeded but whose
   * productId is wrong will fail EVERY renewal, forever. It must be fixed
   * regardless of whether it has a shopifyOrderId.
   *
   * What we must NOT do is RE-QUEUE an order that already reached Shopify —
   * that would create a duplicate. So: always fix the product; only re-queue
   * the ones that never made it. */
  if (!x.o.shopifyOrderId) {
    update["shopifySync.status"] = "pending";
    update["shopifySync.attempts"] = 0;
    update["shopifySync.lastAttemptAt"] = null;
    update["shopifySync.lastError"] = "";
    requeued += 1;
  }

  await OrderModel.updateOne({ _id: x.o._id }, { $set: update });
  fixedProduct += 1;

  /* Unblock any renewal cycle that failed on the bad product. Without this the
     RenewalLog still says "failed" with its attempts spent, so reconcileCron
     won't look at it again — and the order stays stuck even though the data is
     now correct. */
  const r = await RenewalLogModel.updateMany(
    {
      orderId: x.o._id,
      shopifyOrderId: null,
      status: { $in: ["failed", "processing"] },
    },
    {
      $set: {
        status: "failed", // reconcileCron picks up "failed"
        "shopifySync.attempts": 0, // ...and needs attempts under the cap
        "shopifySync.lastAttemptAt": null,
        "shopifySync.lastError": "productId corrected — re-queued",
      },
    },
  );
  logsReset += r.modifiedCount || 0;

  console.log(
    `  ✓ ${x.o._id}  ${x.o.productId} -> ${x.want}` +
      (x.o.shopifyOrderId
        ? "   (already on Shopify — product fixed for FUTURE renewals)"
        : "   (re-queued)"),
  );
}

console.log(`
  ══ done ══
    productId fixed      : ${fixedProduct}
    re-queued to Shopify : ${requeued}   (only orders that never synced)
    RenewalLogs unblocked: ${logsReset}

  ⚠ NOTHING ON SHOPIFY WAS TOUCHED. Existing orders there are unchanged —
    you cannot retroactively swap the product on an order already placed.
    This fixes the DATABASE, so the NEXT renewal uses the right product.

  Make sure the reconciler can actually run:
        db.cronlocks.deleteMany({})
`);

await mongoose.disconnect();
