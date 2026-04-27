import { google } from "googleapis";

function parseCreds(envKey) {
  const raw = process.env[envKey];

  if (!raw) {
    throw new Error(`Missing env variable: ${envKey}`);
  }

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

const wehoSheets = createSheetsClient(parseCreds("GOOGLE_CREDENTIALS_WEHO"));
const laSheets = createSheetsClient(parseCreds("GOOGLE_CREDENTIALS_LA"));

function getSheetConfig(flag) {
  if (flag === "defentLA") {
    if (!process.env.SPREADSHEET_ID_LA) {
      throw new Error("Missing env variable: SPREADSHEET_ID_LA");
    }

    return {
      sheets: laSheets,
      spreadsheetId: process.env.SPREADSHEET_ID_LA,
      sheetTitle: "Orders",
      type: "LA",
    };
  }

  if (!process.env.SPREADSHEET_ID_WEHO) {
    throw new Error("Missing env variable: SPREADSHEET_ID_WEHO");
  }

  return {
    sheets: wehoSheets,
    spreadsheetId: process.env.SPREADSHEET_ID_WEHO,
    sheetTitle: "Orders",
    type: "WEHO",
  };
}

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

function buildRow(o, type) {
  const city = type === "LA" ? "Los Angeles" : "West Hollywood";

  const base = [
    o.createdAt
      ? new Date(o.createdAt).toISOString()
      : new Date().toISOString(),
    o.firstName || "",
    o.lastName || "",
    o.streetAddress || "",
    o.streetAddress2 || "",
    city,
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
    requestBody: {
      values: [headers],
    },
  });
}

export async function appendOrderRow(o, flag) {
  const { sheets, spreadsheetId, sheetTitle, type } = getSheetConfig(flag);

  const headers = getHeaders(type);
  const row = buildRow(o, type);

  await ensureSheetExists(sheets, spreadsheetId, sheetTitle);
  await ensureHeaderRow(sheets, spreadsheetId, sheetTitle, headers);

  const resp = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${sheetTitle}'!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [row],
    },
  });

  return resp.data.updates?.updatedRange || null;
}
