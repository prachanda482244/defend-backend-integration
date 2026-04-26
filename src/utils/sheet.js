import { google } from "googleapis";

/**
 * ================================
 * ENV VARIABLES REQUIRED
 * ================================
 *
 * GOOGLE_CREDENTIALS_WEHO
 * GOOGLE_CREDENTIALS_LA
 * SPREADSHEET_ID_WEHO
 * SPREADSHEET_ID_LA
 */

// ---------- PARSE CREDS ----------
function parseCreds(envKey) {
  const creds = JSON.parse(process.env[envKey]);
  creds.private_key = creds.private_key.replace(/\\n/g, "\n");

  return {
    client_email: creds.client_email,
    private_key: creds.private_key,
  };
}

// ---------- CREATE CLIENT ----------
function createSheetsClient(creds) {
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

// ---------- INIT BOTH CLIENTS ----------
const wehoSheets = createSheetsClient(parseCreds("GOOGLE_CREDENTIALS_WEHO"));

const laSheets = createSheetsClient(parseCreds("GOOGLE_CREDENTIALS_LA"));

// ---------- SWITCH CLIENT ----------
function getSheetConfig(flag) {
  if (flag === "defentLA") {
    return {
      sheets: laSheets,
      spreadsheetId: process.env.SPREADSHEET_ID_LA,
      sheetTitle: "Orders", // or "Defent LA" if you want
      type: "LA",
    };
  }

  return {
    sheets: wehoSheets,
    spreadsheetId: process.env.SPREADSHEET_ID_WEHO,
    sheetTitle: "Orders",
    type: "WEHO",
  };
}

// ---------- HEADERS ----------
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

// ---------- ROW BUILDER ----------
function buildRow(o, type) {
  const base = [
    new Date(o.createdAt).toISOString(),
    o.firstName || "",
    o.lastName || "",
    o.streetAddress || "",
    o.streetAddress2 || "",
    "West Hollywood",
    o.postCode || "",
    o.email || "",
    o.subscription || "",
    o.productId || "",
    o.age || "",
  ];

  if (type === "LA") {
    return [
      ...base,
      o.wehoHearAboutUs || "",
      o.household_size || "",
      o.ethnicity || "",
      o.household_language || "",
    ];
  }

  return [
    ...base,
    o.gender || "",
    o.identity || "",
    o.wehoHearAboutUs || "",
    o.identifyAsLGBTQ || "",
    o.household_size || "",
    o.ethnicity || "",
    o.household_language || "",
  ];
}

// ---------- ENSURE SHEET ----------
async function ensureSheetExists(sheets, spreadsheetId, sheetTitle) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });

  const exists = meta.data.sheets?.some(
    (s) => s.properties?.title === sheetTitle,
  );

  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: { title: sheetTitle },
          },
        },
      ],
    },
  });
}

// ---------- ENSURE HEADER ----------
async function ensureHeaderRow(sheets, spreadsheetId, sheetTitle, headers) {
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTitle}!A1:A1`,
  });

  const hasHeader =
    Array.isArray(read.data.values) && read.data.values.length > 0;

  if (hasHeader) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetTitle}!A1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [headers],
    },
  });
}

// ---------- MAIN FUNCTION ----------
export async function appendOrderRow(o, flag) {
  const { sheets, spreadsheetId, sheetTitle, type } = getSheetConfig(flag);

  const headers = getHeaders(type);
  const row = buildRow(o, type);

  await ensureSheetExists(sheets, spreadsheetId, sheetTitle);
  await ensureHeaderRow(sheets, spreadsheetId, sheetTitle, headers);

  const resp = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: sheetTitle,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [row],
    },
  });

  return resp.data.updates?.updatedRange || null;
}
