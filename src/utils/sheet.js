/* ------------------------------------------------------------------ *
 *  sheetsService.js
 *
 *  Wired to the REAL Google Sheets client (JWT per flag), same layout,
 *  headers, and "Orders" tab as appendOrderRow.
 *
 *  ++ WHAT CHANGED (and why it matters at 100+ orders/day) ++
 *
 *  Google Sheets allows ~60 reads/min and ~60 writes/min per project.
 *  The old appendRowsBatch() made THREE API calls for every append:
 *      1. spreadsheets.get        (does the tab exist?)   <- READ
 *      2. values.get A1:A1        (is there a header?)    <- READ
 *      3. values.append           (the actual row)        <- WRITE
 *  Called from appendSingleAndMark() that is 3 calls PER ORDER — and a
 *  monthly order also hits monthlySheet.js for 3 more. So ~6 calls/order.
 *  A burst of 15 orders in a minute is already 90 reads: instant 429,
 *  the append throws, the row is marked "failed", and the customer is
 *  missing from the sheet until someone notices.
 *
 *  FIXES (behaviour identical, exports identical):
 *   1. MEMOISE the tab/header check per (spreadsheetId, tab). It can only
 *      ever go from "missing" to "present", so re-checking every append is
 *      pure waste. -> 3 calls/order becomes 1.
 *   2. RETRY 429/5xx with exponential backoff + jitter (retry.js).
 *   3. PACE writes so a backlog flush can't burst into the limit.
 * ------------------------------------------------------------------ */

import { google } from "googleapis";
import { OrderModel, RenewalLogModel } from "../model/orderModel.js";
import { withRetry, createPacer } from "./retry.js";

const joinMulti = (v) =>
  Array.isArray(v) ? v.filter(Boolean).join(", ") : v || "";

/* ~3 calls/sec — comfortably inside 60/min, and irrelevant once the
   ensure* calls are cached away. */
const pacedSheets = createPacer(Number(process.env.SHEETS_PACE_MS || 350));

const call = (fn, label) =>
  pacedSheets(() =>
    withRetry(fn, { retries: 5, baseMs: 700, maxMs: 30_000, label }),
  );

/* ====== Google auth (lazy + memoized per flag) ==================== */
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

  /* ONE service account for everything, unless you opt out.
   *
   * A service account is just an identity — it can edit ANY sheet that is
   * shared with its email. monthlySheet.js already reuses the WEHO account
   * for the Monthly sheet; this extends the same rule to the LA sheet.
   *
   *   - GOOGLE_CREDENTIALS_LA set     -> LA uses its own account (old behaviour)
   *   - GOOGLE_CREDENTIALS_LA missing -> LA falls back to GOOGLE_CREDENTIALS_WEHO
   *
   * ⚠ For the fallback to work the LA spreadsheet must be shared (Editor)
   *   with the WEHO service-account email, or every write returns 403. */
  const envKey =
    type === "LA" && process.env.GOOGLE_CREDENTIALS_LA
      ? "GOOGLE_CREDENTIALS_LA"
      : "GOOGLE_CREDENTIALS_WEHO";

  /* Same account -> same client. Sharing the instance keeps ONE token
     cache and ONE pacer chain instead of two identical ones. */
  if (envKey === "GOOGLE_CREDENTIALS_WEHO" && _clients.WEHO) {
    _clients[type] = _clients.WEHO;
    return _clients[type];
  }

  _clients[type] = createSheetsClient(parseCreds(envKey));
  if (envKey === "GOOGLE_CREDENTIALS_WEHO") _clients.WEHO = _clients[type];
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

/* ====== Columns (UNCHANGED) ====================================== */
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

/** Build the ordered row ARRAY from an order DOC. (UNCHANGED) */
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

/* ++ ADDED: memoise the tab/header check. A tab that exists cannot stop
   existing; a header that's written stays written. Re-verifying on every
   append is what was silently eating the read quota. ++ */
const _ensured = new Set(); // `${spreadsheetId}::${sheetTitle}`

async function ensureTabAndHeader(sheets, spreadsheetId, sheetTitle, headers) {
  const key = `${spreadsheetId}::${sheetTitle}`;
  if (_ensured.has(key)) return; // <- the whole optimisation

  const meta = await call(
    () => sheets.spreadsheets.get({ spreadsheetId }),
    "sheets:get",
  );
  const exists = meta.data.sheets?.some(
    (s) => s.properties?.title === sheetTitle,
  );

  if (!exists) {
    await call(
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title: sheetTitle } } }],
          },
        }),
      "sheets:addSheet",
    );
  }

  const read = await call(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetTitle}'!A1:A1`,
      }),
    "sheets:headerGet",
  );
  const hasHeader =
    Array.isArray(read.data.values) && read.data.values.length > 0;

  if (!hasHeader) {
    await call(
      () =>
        sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `'${sheetTitle}'!A1`,
          valueInputOption: "RAW",
          requestBody: { values: [headers] },
        }),
      "sheets:headerWrite",
    );
  }

  _ensured.add(key);
}

/* ------------------------------------------------------------------ *
 *  appendRowsBatch — append MANY order docs in ONE API call.
 *  Signature UNCHANGED.  entries: [{ order, when? }]  (all same flag)
 * ------------------------------------------------------------------ */
export async function appendRowsBatch(entries, flag) {
  if (!entries.length) return { appended: 0 };

  const { sheets, spreadsheetId, sheetTitle, type } = getSheetConfig(flag);
  const headers = getHeaders(type);
  const values = entries.map(({ order, when }) =>
    orderToRow(order, type, when),
  );

  await ensureTabAndHeader(sheets, spreadsheetId, sheetTitle, headers);

  await call(
    () =>
      sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `'${sheetTitle}'!A1`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values },
      }),
    "sheets:append",
  );

  return { appended: values.length };
}

/** Single append from an order doc — convenience/back-compat. UNCHANGED. */
export async function appendOrderRow(order, flag) {
  return appendRowsBatch([{ order, when: order.createdAt }], flag);
}

/* ------------------------------------------------------------------ *
 *  appendSingleAndMark — first-time intake path. Best-effort; the flush
 *  is the guarantee. Never throws. UNCHANGED behaviour.
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
          "sheetSync.lastError": String(
            e?.message || "sheet append failed",
          ).slice(0, 500),
          "sheetSync.lastAttemptAt": new Date(),
        },
        $inc: { "sheetSync.attempts": 1 },
      },
    );
    // Not fatal: reconcileCron flushes every 10 minutes, so the row lands
    // shortly after even if Sheets was rate-limiting us at intake time.
    console.error("[sheets] intake append failed (will flush):", e?.message);
  }
}

/* ------------------------------------------------------------------ *
 *  flushPendingSheets — THE BACKSTOP. Batches every pending/failed
 *  first-time order + completed-but-unsynced renewal cycle into per-flag
 *  append calls. Idempotent. Signature UNCHANGED.
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
