/* ------------------------------------------------------------------ *
 *  sheetsService.js
 *
 *  Wired to the REAL Google Sheets client (JWT per flag) using the same
 *  spreadsheet layout, headers, and "Orders" tab as appendOrderRow.
 *
 *  What this adds on top of the original single-row appendOrderRow:
 *   - BATCHED writes  : flushPendingSheets() appends many rows in ONE
 *                       values.append call (Sheets allows ~60 writes/min;
 *                       100 renewals as 100 calls would 429 — this is one).
 *   - SYNC TRACKING   : appendSingleAndMark() flips order.sheetSync.
 *   - BACKSTOP        : flushPendingSheets() re-tries anything still
 *                       pending/failed; idempotent (rows flip to synced).
 *
 *  Order-doc shape: demographics are NESTED (order.demographics.gender),
 *  unlike the old flat payload — the row builder reads from the doc.
 * ------------------------------------------------------------------ */

import { google } from "googleapis";
import { OrderModel, RenewalLogModel } from "../model/orderModel.js";

const joinMulti = (v) =>
  Array.isArray(v) ? v.filter(Boolean).join(", ") : v || "";

/* ====== Google auth (lazy + memoized per flag) ====================
 * Lazy so a missing LA credential doesn't crash the whole app before
 * the LA launch — creds are only required when a row for that flag is
 * actually written.                                                   */
function parseCreds(envKey) {
  const raw = process.env[envKey];
  if (!raw) throw new Error(`Missing env variable: ${envKey}`);
  const creds = JSON.parse(raw);
  if (!creds.client_email || !creds.private_key) {
    throw new Error(`Invalid Google credentials in ${envKey}`);
  }
  return {
    client_email: creds.client_email,
    private_key: creds.private_key.replace(/\\n/g, "\n"),
  };
}

function createSheetsClient(creds) {
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

const _clients = {};
function getClient(type) {
  if (_clients[type]) return _clients[type];
  const envKey =
    type === "LA" ? "GOOGLE_CREDENTIALS_LA" : "GOOGLE_CREDENTIALS_WEHO";
  _clients[type] = createSheetsClient(parseCreds(envKey));
  return _clients[type];
}

function getSheetConfig(flag) {
  if (flag === "defentLA") {
    if (!process.env.SPREADSHEET_ID_LA)
      throw new Error("Missing env variable: SPREADSHEET_ID_LA");
    return {
      sheets: getClient("LA"),
      spreadsheetId: process.env.SPREADSHEET_ID_LA,
      sheetTitle: "Orders",
      type: "LA",
    };
  }
  if (!process.env.SPREADSHEET_ID_WEHO)
    throw new Error("Missing env variable: SPREADSHEET_ID_WEHO");
  return {
    sheets: getClient("WEHO"),
    spreadsheetId: process.env.SPREADSHEET_ID_WEHO,
    sheetTitle: "Orders",
    type: "WEHO",
  };
}

/* ====== Columns (same as your appendOrderRow) ===================== */
function getHeaders(type) {
  const base = [
    "Created ISO",
    "First Name",
    "Last Name",
    "Street Address",
    "Street Address 2",
    "City",
    "Post Code",
    "Email",
    "Subscription",
    "Product/Variant",
    "Age",
  ];
  if (type === "LA") {
    return [
      ...base,
      "Hear about us ?",
      "Household Size",
      "Ethnicity",
      "Household Language",
    ];
  }
  return [
    ...base,
    "Gender",
    "Identity",
    "Hear about us ?",
    "Identify as LGBTQ+?",
    "Household Size",
    "Ethnicity",
    "Household Language",
  ];
}

/** Build the ordered row ARRAY from an order DOC (nested demographics). */
function orderToRow(order, type, when) {
  const d = order.demographics || {};
  const city = type === "LA" ? "Los Angeles" : "West Hollywood";
  const created = when
    ? new Date(when).toISOString()
    : order.createdAt
      ? new Date(order.createdAt).toISOString()
      : new Date().toISOString();

  const base = [
    created,
    order.firstName || "",
    order.lastName || "",
    order.streetAddress || "",
    order.streetAddress2 || "",
    city,
    String(order.postCode || "").slice(0, 5),
    order.email || "",
    order.subscription || "",
    order.productId || "",
    d.age || "",
  ];

  if (type === "LA") {
    return [
      ...base,
      d.wehoHearAboutUs || "",
      d.household_size || "",
      joinMulti(d.ethnicity),
      joinMulti(d.household_language),
    ];
  }

  return [
    ...base,
    d.gender || "",
    d.identity || "",
    d.wehoHearAboutUs || "",
    d.identifyAsLGBTQ || "",
    d.household_size || "",
    joinMulti(d.ethnicity),
    joinMulti(d.household_language),
  ];
}

async function ensureSheetExists(sheets, spreadsheetId, sheetTitle) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = meta.data.sheets?.some(
    (s) => s.properties?.title === sheetTitle,
  );
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetTitle } } }],
    },
  });
}

async function ensureHeaderRow(sheets, spreadsheetId, sheetTitle, headers) {
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetTitle}'!A1:A1`,
  });
  const hasHeader =
    Array.isArray(read.data.values) && read.data.values.length > 0;
  if (hasHeader) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${sheetTitle}'!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers] },
  });
}

/* ------------------------------------------------------------------ *
 *  appendRowsBatch — append MANY order docs in ONE API call.
 *  entries: [{ order, when? }]  (all same flag)
 *  ensure* run once per batch, not per row.
 * ------------------------------------------------------------------ */
export async function appendRowsBatch(entries, flag) {
  if (!entries.length) return { appended: 0 };

  const { sheets, spreadsheetId, sheetTitle, type } = getSheetConfig(flag);
  const headers = getHeaders(type);
  const values = entries.map(({ order, when }) =>
    orderToRow(order, type, when),
  );

  await ensureSheetExists(sheets, spreadsheetId, sheetTitle);
  await ensureHeaderRow(sheets, spreadsheetId, sheetTitle, headers);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${sheetTitle}'!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  return { appended: values.length };
}

/** Single append from an order doc — convenience/back-compat. */
export async function appendOrderRow(order, flag) {
  return appendRowsBatch([{ order, when: order.createdAt }], flag);
}

/* ------------------------------------------------------------------ *
 *  appendSingleAndMark — first-time intake path. Best-effort; the
 *  flush is the guarantee. Never throws (failures become retryable).
 * ------------------------------------------------------------------ */
export async function appendSingleAndMark(order, flag) {
  try {
    await appendRowsBatch([{ order, when: order.createdAt }], flag);
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          "sheetSync.status": "synced",
          "sheetSync.lastAttemptAt": new Date(),
        },
        $inc: { "sheetSync.attempts": 1 },
      },
    );
  } catch (e) {
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          "sheetSync.status": "failed",
          "sheetSync.lastError": e?.message || "sheet append failed",
          "sheetSync.lastAttemptAt": new Date(),
        },
        $inc: { "sheetSync.attempts": 1 },
      },
    );
  }
}

/* ------------------------------------------------------------------ *
 *  flushPendingSheets — THE BACKSTOP.
 *  Batches every pending/failed first-time order + completed-but-unsynced
 *  renewal cycle into per-flag append calls. Idempotent.
 * ------------------------------------------------------------------ */
export async function flushPendingSheets({ limit = 500 } = {}) {
  const summary = { firstTime: 0, renewals: 0, failedBatches: 0 };

  /* ---- first-time orders ---- */
  const pendingOrders = await OrderModel.find({
    "sheetSync.status": { $in: ["pending", "failed"] },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();

  const byFlag = { defentLA: [], defentWeho: [] };
  const idsByFlag = { defentLA: [], defentWeho: [] };
  for (const o of pendingOrders) {
    const flag = o.source === "Defent La" ? "defentLA" : "defentWeho";
    byFlag[flag].push({ order: o, when: o.createdAt });
    idsByFlag[flag].push(o._id);
  }

  for (const flag of Object.keys(byFlag)) {
    if (!byFlag[flag].length) continue;
    try {
      await appendRowsBatch(byFlag[flag], flag);
      await OrderModel.updateMany(
        { _id: { $in: idsByFlag[flag] } },
        {
          $set: {
            "sheetSync.status": "synced",
            "sheetSync.lastAttemptAt": new Date(),
          },
        },
      );
      summary.firstTime += byFlag[flag].length;
    } catch (e) {
      summary.failedBatches += 1;
      console.error(`[sheets] first-time batch (${flag}) failed:`, e?.message);
    }
  }

  /* ---- renewal cycles (only those whose Shopify side completed) ---- */
  const pendingRenewals = await RenewalLogModel.find({
    "sheetSync.status": { $in: ["pending", "failed"] },
    status: "completed",
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .populate("orderId")
    .lean();

  const rByFlag = { defentLA: [], defentWeho: [] };
  const rIdsByFlag = { defentLA: [], defentWeho: [] };
  for (const r of pendingRenewals) {
    const o = r.orderId;
    if (!o) continue;
    const flag = o.source === "Defent La" ? "defentLA" : "defentWeho";
    rByFlag[flag].push({ order: o, when: r.createdAt }); // renewal timestamp
    rIdsByFlag[flag].push(r._id);
  }

  for (const flag of Object.keys(rByFlag)) {
    if (!rByFlag[flag].length) continue;
    try {
      await appendRowsBatch(rByFlag[flag], flag);
      await RenewalLogModel.updateMany(
        { _id: { $in: rIdsByFlag[flag] } },
        {
          $set: {
            "sheetSync.status": "synced",
            "sheetSync.lastAttemptAt": new Date(),
          },
        },
      );
      summary.renewals += rByFlag[flag].length;
    } catch (e) {
      summary.failedBatches += 1;
      console.error(`[sheets] renewal batch (${flag}) failed:`, e?.message);
    }
  }

  return summary;
}
