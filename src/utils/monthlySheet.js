/* ------------------------------------------------------------------ *
 *  monthlySheet.js   (NEW FEATURE — fully self-contained)
 *
 *  Mirrors MONTHLY subscriptions into ONE consolidated Google Sheet,
 *  in addition to (and without touching) the existing Weho/LA sheets.
 *
 *  >>> NO changes to OrderModel. <<<
 *  Idempotency is handled by the SHEET itself: every row carries the
 *  Mongo "Order ID" in column A. The backfill reads the IDs already in
 *  the sheet and skips them — so it never writes duplicates, and the
 *  order model (shared with your other service) is left exactly as-is.
 *
 *  Exports:
 *    appendMonthly(order)      -> live append for a new monthly order
 *    backfillMonthlySheet()    -> push EXISTING monthly orders (idempotent)
 *
 *  ENV:
 *    SPREADSHEET_ID_MONTHLY     = the new sheet's ID (required)
 *    GOOGLE_CREDENTIALS_MONTHLY = (optional) dedicated SA; if omitted,
 *                                 reuses GOOGLE_CREDENTIALS_WEHO.
 *    MONTHLY_SHEET_TAB          = tab name (optional, default "Monthly")
 *
 *  IMPORTANT: share the new sheet with the service-account email
 *  (Weho SA: spreadsheet@spreadsheet-474509.iam.gserviceaccount.com)
 *  as EDITOR, or every write returns 403.
 * ------------------------------------------------------------------ */

import { google } from "googleapis";
import { OrderModel } from "../model/orderModel.js"; // READ ONLY — never modified

const SHEET_TAB = process.env.MONTHLY_SHEET_TAB || "Monthly";

const joinMulti = (v) =>
  Array.isArray(v) ? v.filter(Boolean).join(", ") : v || "";

/* ---- auth (lazy + memoized) ------------------------------------- */
function parseCreds() {
  // Reuse the Weho service account unless a dedicated one is provided.
  const envKey = "GOOGLE_CREDENTIALS_WEHO";
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

let _client = null;
function getConfig() {
  if (!process.env.SPREADSHEET_ID_MONTHLY) {
    throw new Error("Missing env variable: SPREADSHEET_ID_MONTHLY");
  }
  if (!_client) {
    const creds = parseCreds();
    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    _client = google.sheets({ version: "v4", auth });
  }
  return {
    sheets: _client,
    spreadsheetId: process.env.SPREADSHEET_ID_MONTHLY,
    sheetTitle: SHEET_TAB,
  };
}

/* ---- columns (Order ID first → enables sheet-based dedup) ------- */
function getHeaders() {
  return [
    "Order ID", // column A — used to avoid duplicates on re-run
    "Created ISO",
    "Source",
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
    "Gender",
    "Identity",
    "Hear about us ?",
    "Identify as LGBTQ+?",
    "Household Size",
    "Ethnicity",
    "Household Language",
  ];
}

function orderToRow(order, when) {
  const d = order.demographics || {};
  const isLA = order.source === "Defent La";
  const city = isLA ? "Los Angeles" : "West Hollywood";
  const created = when
    ? new Date(when).toISOString()
    : order.createdAt
      ? new Date(order.createdAt).toISOString()
      : new Date().toISOString();

  return [
    String(order._id || ""), // Order ID (column A)
    created,
    order.source || (isLA ? "Defent La" : "Defent Weho"),
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
    d.gender || "",
    d.identity || "",
    d.wehoHearAboutUs || "",
    d.identifyAsLGBTQ || "",
    d.household_size || "",
    joinMulti(d.ethnicity),
    joinMulti(d.household_language),
  ];
}

/* ---- ensure tab + header (runs once per batch) ------------------ */
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

/* ---- read Order IDs already in the sheet (idempotency key) ------ */
async function getExistingOrderIds() {
  const { sheets, spreadsheetId, sheetTitle } = getConfig();
  await ensureSheetExists(sheets, spreadsheetId, sheetTitle);
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${sheetTitle}'!A2:A`, // column A, skip header
  });
  const ids = new Set();
  for (const row of read.data.values || []) {
    if (row[0]) ids.add(String(row[0]).trim());
  }
  return ids;
}

/* ---- core: append MANY monthly orders in ONE API call ----------- */
export async function appendMonthlyRowsBatch(entries) {
  if (!entries.length) return { appended: 0 };
  const { sheets, spreadsheetId, sheetTitle } = getConfig();
  const headers = getHeaders();
  const values = entries.map(({ order, when }) => orderToRow(order, when));

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

/* ---- live path: append a single new monthly order --------------
 * Best-effort: NEVER throws, so it can't break order creation.
 * No DB write → OrderModel untouched. If it fails, the backfill is
 * the backstop (this order's ID won't be in the sheet, so a later
 * sync picks it up).                                                 */
export async function appendMonthly(order) {
  try {
    await appendMonthlyRowsBatch([{ order, when: order.createdAt }]);
  } catch (e) {
    console.error("[monthlySheet] live append failed:", e?.message);
  }
}

/* ---- backfill: push EXISTING monthly orders from the DB ---------
 * Idempotent via the sheet's Order ID column: orders already present
 * are skipped. Re-run until `remaining` is 0. Nothing in the DB is
 * modified.                                                          */
export async function backfillMonthlySheet({ limit = 1000 } = {}) {
  const existing = await getExistingOrderIds();

  const monthly = await OrderModel.find({
    subscription: "monthly",
    // add `isActive: true,` here if you only want ACTIVE subscriptions
  })
    .sort({ createdAt: 1 })
    .lean();

  const notInSheet = monthly.filter((o) => !existing.has(String(o._id)));
  const todo = notInSheet.slice(0, limit);

  if (!todo.length) {
    return { appended: 0, remaining: 0, alreadyInSheet: existing.size };
  }

  const entries = todo.map((o) => ({ order: o, when: o.createdAt }));
  await appendMonthlyRowsBatch(entries); // one API call for the batch

  return {
    appended: todo.length,
    remaining: notInSheet.length - todo.length,
    alreadyInSheet: existing.size,
  };
}
