/* ------------------------------------------------------------------ *
 *  monthlySheet.js
 *
 *  Mirrors MONTHLY subscriptions into ONE consolidated Google Sheet, in
 *  addition to (and without touching) the existing Weho/LA sheets.
 *
 *  >>> Still NO changes to how OrderModel is used here. <<<
 *  Idempotency is handled by the SHEET itself: every row carries the
 *  Mongo "Order ID" in column A. The backfill reads the IDs already in
 *  the sheet and skips them — so it never writes duplicates.
 *
 *  ++ WHAT CHANGED ++
 *   1. Tab/header check is now MEMOISED (it was 2 extra Sheets reads on
 *      every single monthly order — see the note in sheet.js).
 *   2. All Sheets calls go through withRetry (429 / 5xx backoff).
 *   3. appendMonthly() no longer silently loses a row on failure: the
 *      Order ID simply isn't in column A, so the next backfill pass
 *      (now run automatically by reconcileCron) picks it up. Same
 *      contract as before, just actually self-healing now.
 *
 *  ENV:
 *    SPREADSHEET_ID_MONTHLY     = the new sheet's ID (required)
 *    GOOGLE_CREDENTIALS_WEHO    = service-account JSON (reused)
 *    MONTHLY_SHEET_TAB          = tab name (optional, default "Monthly")
 *
 *  IMPORTANT: share the new sheet with the service-account email
 *  (spreadsheet@spreadsheet-474509.iam.gserviceaccount.com) as EDITOR,
 *  or every write returns 403.
 * ------------------------------------------------------------------ */

import { google } from "googleapis";
import { RECURRING_MATCH } from "./cycle.js";
import { OrderModel } from "../model/orderModel.js"; // READ ONLY — never modified
import { withRetry, createPacer } from "./retry.js";

const SHEET_TAB = process.env.MONTHLY_SHEET_TAB || "Monthly";

const joinMulti = (v) =>
  Array.isArray(v) ? v.filter(Boolean).join(", ") : v || "";

const pacedSheets = createPacer(Number(process.env.SHEETS_PACE_MS || 350));
const call = (fn, label) =>
  pacedSheets(() =>
    withRetry(fn, { retries: 5, baseMs: 700, maxMs: 30_000, label }),
  );

/* ---- auth (lazy + memoized) ------------------------------------- */
function parseCreds() {
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

/** True when the consolidated monthly sheet is configured. */
export function monthlySheetReady() {
  return Boolean(
    process.env.SPREADSHEET_ID_MONTHLY && process.env.GOOGLE_CREDENTIALS_WEHO,
  );
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

/* ---- ensure tab + header (MEMOISED — see sheet.js) -------------- */
const _ensured = new Set();

async function ensureTabAndHeader(sheets, spreadsheetId, sheetTitle, headers) {
  const key = `${spreadsheetId}::${sheetTitle}`;
  if (_ensured.has(key)) return;

  const meta = await call(
    () => sheets.spreadsheets.get({ spreadsheetId }),
    "monthly:get",
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
      "monthly:addSheet",
    );
  }

  const read = await call(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetTitle}'!A1:A1`,
      }),
    "monthly:headerGet",
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
      "monthly:headerWrite",
    );
  }

  _ensured.add(key);
}

/* ---- read Order IDs already in the sheet (idempotency key) ------ */
async function getExistingOrderIds() {
  const { sheets, spreadsheetId, sheetTitle } = getConfig();
  await ensureTabAndHeader(sheets, spreadsheetId, sheetTitle, getHeaders());

  const read = await call(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${sheetTitle}'!A2:A`, // column A, skip header
      }),
    "monthly:idScan",
  );

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
    "monthly:append",
  );

  return { appended: values.length };
}

/* ---- live path: append a single new monthly order ---------------
 * Best-effort: NEVER throws, so it can't break order creation.
 * If it fails, the order's ID is simply absent from column A, and the
 * automatic backfill (reconcileCron, every 10 min) picks it up.       */
export async function appendMonthly(order) {
  if (!monthlySheetReady()) return;
  try {
    await appendMonthlyRowsBatch([{ order, when: order.createdAt }]);
  } catch (e) {
    console.error(
      "[monthlySheet] live append failed (backfill will heal):",
      e?.message,
    );
  }
}

/* ---- backfill: push EXISTING monthly orders from the DB ---------
 * Idempotent via the sheet's Order ID column. Nothing in the DB is
 * modified. Safe to run on a schedule — this is now the self-healing
 * backstop for any live append that lost a race with a 429.           */
export async function backfillMonthlySheet({ limit = 1000 } = {}) {
  if (!monthlySheetReady()) {
    return { appended: 0, remaining: 0, alreadyInSheet: 0, skipped: true };
  }

  const existing = await getExistingOrderIds();

  const monthly = await OrderModel.find({ subscription: RECURRING_MATCH })
    .sort({ createdAt: 1 })
    .lean();

  const notInSheet = monthly.filter((o) => !existing.has(String(o._id)));
  const todo = notInSheet.slice(0, limit);

  if (!todo.length) {
    return { appended: 0, remaining: 0, alreadyInSheet: existing.size };
  }

  /* Chunk the write. Sheets will happily take thousands of rows in one
     append, but a single monster request is also a single point of
     failure — 500 at a time keeps a transient error cheap to retry. */
  const CHUNK = 500;
  let appended = 0;
  for (let i = 0; i < todo.length; i += CHUNK) {
    const slice = todo.slice(i, i + CHUNK);
    await appendMonthlyRowsBatch(
      slice.map((o) => ({ order: o, when: o.createdAt })),
    );
    appended += slice.length;
  }

  return {
    appended,
    remaining: notInSheet.length - appended,
    alreadyInSheet: existing.size,
  };
}
