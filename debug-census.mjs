// debug-census.mjs — run the exact escalation ladder for one address
// usage: node debug-census.mjs "1145 N. Ogden Dr" 90046 weho
import "dotenv/config";

const [, , line1 = "1145 N. Ogden Dr", zip = "90046", site = "weho"] =
  process.argv;
const isLA = site.toLowerCase() === "la";
const city = isLA ? "Los Angeles" : "West Hollywood";
const zip5 = String(zip).slice(0, 5);

const BASE =
  "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
const BENCHMARK = process.env.CENSUS_BENCHMARK || "Public_AR_Current";
const VINTAGE = process.env.CENSUS_VINTAGE || "Current_Current";

const attempts = [
  `${line1}, ${city}, CA ${zip5}`,
  `${line1}, ${city}, CA`,
  `${line1}, CA ${zip5}`,
  ...(!isLA ? [`${line1}, Los Angeles, CA`] : []),
  `${line1}, CA`,
];

for (const q of attempts) {
  const url = new URL(BASE);
  url.search = new URLSearchParams({
    address: q,
    benchmark: BENCHMARK,
    vintage: VINTAGE,
    format: "json",
  });
  const r = await fetch(url);
  const data = await r.json().catch(() => null);
  const m = data?.result?.addressMatches?.[0];
  if (!m) {
    console.log(`✗ NO MATCH   "${q}"`);
    continue;
  }
  const place = m.geographies?.["Incorporated Places"]?.[0];
  console.log(`✓ MATCH      "${q}"`);
  console.log(`   matched:  ${m.matchedAddress}`);
  console.log(
    `   place:    ${place?.NAME || "(no Incorporated Places layer)"}   <- THE DECISION FIELD`,
  );
}
