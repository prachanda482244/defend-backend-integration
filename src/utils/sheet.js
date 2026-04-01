import { google } from "googleapis";

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DEFAULT_SHEET_TITLE = "Orders";

const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
creds.private_key = creds.private_key.replace(/\\n/g, "\n");

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: creds.client_email,
    private_key: creds.private_key,
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

function getSheetTitle(flag) {
  if (flag === "defentLA") return "DefentLA";
  return DEFAULT_SHEET_TITLE; // defentWeho -> Orders
}

async function ensureSheetExists(sheetTitle) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });

  const hasSheet = meta.data.sheets?.some(
    (s) => s.properties?.title === sheetTitle,
  );

  if (hasSheet) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
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

async function ensureHeaderRow(sheetTitle) {
  const read = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTitle}!A1:A1`,
  });

  const hasHeader =
    Array.isArray(read.data.values) && read.data.values.length > 0;

  if (hasHeader) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetTitle}!A1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        [
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
          "Gender",
          "Identity",
          "Hear about us ?",
          "Identify as LGBTQ+?",
          "Household Size",
          "Ethnicity",
          "Household Language",
        ],
      ],
    },
  });
}

export async function appendOrderRow(o, flag) {
  const sheetTitle = getSheetTitle(flag);

  await ensureSheetExists(sheetTitle);
  await ensureHeaderRow(sheetTitle);

  const values = [
    [
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
      o.gender || "",
      o.identity || "",
      o.wehoHearAboutUs || "",
      o.identifyAsLGBTQ || "",
      o.household_size || "",
      o.ethnicity || "",
      o.household_language || "",
    ],
  ];

  const resp = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetTitle,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });

  return resp.data.updates?.updatedRange || null;
}
