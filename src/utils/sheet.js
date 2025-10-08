// sheet.js
import { google } from "googleapis";
import fs from "fs";
import path from "path";

const SPREADSHEET_ID = "1d2tXxlh95rwl7E8kT5WS_ooxDgZCzDYv8kHfDJ2-LRM";
const SHEET_TITLE = "Orders"; // tab name

// Load JSON creds from project root
const keyPath = path.resolve(process.cwd(), "credentials.json");
const creds = JSON.parse(fs.readFileSync(keyPath, "utf8"));

// Auth WITHOUT deprecated options
// Option A: GoogleAuth with credentials (clean, no warnings)
const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: creds.client_email,
    private_key: creds.private_key,
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

// Option B: JWT constructor (also valid, pick ONE)
// const auth = new google.auth.JWT(
//   creds.client_email,
//   undefined,
//   creds.private_key,
//   ['https://www.googleapis.com/auth/spreadsheets']
// );

const sheets = google.sheets({ version: "v4", auth });

async function ensureSheetExists() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const has = meta.data.sheets?.some(
    (s) => s.properties?.title === SHEET_TITLE
  );
  if (has) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: SHEET_TITLE } } }],
    },
  });
}

async function ensureHeaderRow() {
  // Writes header only if A1 is empty
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TITLE}!A1:A1`,
  });
  const hasHeader = Array.isArray(read.data.values) && read.data.values.length;
  if (hasHeader) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TITLE}!A1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        [
          "Created ISO",
          "First Name",
          "Last Name",
          "Street Address",
          "Post Code",
          "Email",
          "Subscription",
          "Product/Variant",
          "Age",
          "Gender",
          "Identity",
          "Household Size",
          "Ethnicity",
          "Household Language",
        ],
      ],
    },
  });
}

export async function appendOrderRow(o) {
  await ensureSheetExists();
  await ensureHeaderRow();

  const values = [
    [
      new Date(o.createdAt).toISOString(),
      o.firstName || "",
      o.lastName || "",
      o.streetAddress || "",
      o.postCode || "",
      o.email || "",
      o.subscription || "",
      o.productId || "",
      o.age || "",
      o.gender || "",
      o.identity || "",
      o.household_size || "",
      o.ethnicity || "",
      o.household_language || "",
    ],
  ];

  // Using range = sheet title is valid and avoids A1 parsing issues
  const resp = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_TITLE, // instead of 'Orders!A1'
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
  return resp.data.updates?.updatedRange || null;
}
