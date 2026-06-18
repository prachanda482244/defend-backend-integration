const WEHO_ZIPS = new Set(["90038", "90046", "90048", "90069"]);
const LA_ZIPS = new Set([
  "90001",
  "90002",
  "90003",
  "90004",
  "90005",
  "90006",
  "90007",
  "90008",
  "90010",
  "90011",
  "90012",
  "90013",
  "90014",
  "90015",
  "90016",
  "90017",
  "90018",
  "90019",
  "90020",
  "90021",
  "90022",
  "90023",
  "90024",
  "90025",
  "90026",
  "90027",
  "90028",
  "90029",
  "90031",
  "90032",
  "90033",
  "90034",
  "90035",
  "90036",
  "90037",
  "90038",
  "90039",
  "90040",
  "90041",
  "90042",
  "90043",
  "90044",
  "90045",
  "90046",
  "90047",
  "90048",
  "90049",
  "90056",
  "90057",
  "90058",
  "90059",
  "90061",
  "90062",
  "90063",
  "90064",
  "90065",
  "90066",
  "90067",
  "90068",
  "90069",
  "90071",
  "90073",
  "90077",
  "90089",
  "90094",
  "90095",
]);

// Candidates — known landmarks in each area. Some may still come back
// not_found due to TIGER coverage gaps; that's why we test.
const candidates = [
  // ===== WeHo =====
  { line1: "8300 Santa Monica Blvd", zip: "90069", area: "WeHo" }, // City Hall
  { line1: "625 N San Vicente Blvd", zip: "90069", area: "WeHo" }, // WeHo Library
  { line1: "8901 Sunset Blvd", zip: "90069", area: "WeHo" }, // Whisky a Go Go
  { line1: "9009 Sunset Blvd", zip: "90069", area: "WeHo" }, // The Roxy
  { line1: "8433 Sunset Blvd", zip: "90069", area: "WeHo" }, // Comedy Store
  { line1: "8852 Sunset Blvd", zip: "90069", area: "WeHo" }, // Viper Room
  { line1: "9081 Santa Monica Blvd", zip: "90069", area: "WeHo" }, // Troubadour
  { line1: "8687 Melrose Ave", zip: "90069", area: "WeHo" }, // Pacific Design Ctr
  { line1: "692 N Robertson Blvd", zip: "90069", area: "WeHo" }, // The Abbey
  { line1: "8440 Sunset Blvd", zip: "90069", area: "WeHo" }, // Mondrian
  { line1: "8221 Sunset Blvd", zip: "90046", area: "WeHo" }, // Chateau Marmont
  { line1: "7377 Santa Monica Blvd", zip: "90046", area: "WeHo" }, // Plummer Park
  { line1: "1020 N San Vicente Blvd", zip: "90069", area: "WeHo" },
  { line1: "8500 Beverly Blvd", zip: "90048", area: "WeHo" }, // Beverly Center
  { line1: "8730 W Sunset Blvd", zip: "90069", area: "WeHo" },

  // ===== LA =====
  { line1: "6925 Hollywood Blvd", zip: "90028", area: "LA" }, // TCL Chinese
  { line1: "6801 Hollywood Blvd", zip: "90028", area: "LA" }, // Dolby Theatre
  { line1: "1750 Vine St", zip: "90028", area: "LA" }, // Capitol Records
  { line1: "5905 Wilshire Blvd", zip: "90036", area: "LA" }, // LACMA
  { line1: "189 The Grove Dr", zip: "90036", area: "LA" }, // The Grove
  { line1: "200 N Spring St", zip: "90012", area: "LA" }, // City Hall
  { line1: "111 S Grand Ave", zip: "90012", area: "LA" }, // Disney Concert Hall
  { line1: "1111 S Figueroa St", zip: "90015", area: "LA" }, // Crypto.com Arena
  { line1: "405 Hilgard Ave", zip: "90095", area: "LA" }, // UCLA
  { line1: "2800 E Observatory Rd", zip: "90027", area: "LA" }, // Griffith Obs.
];

async function check(line1, zip, area) {
  const city = area === "WeHo" ? "West Hollywood" : "Los Angeles";
  const oneLine = `${line1}, ${city}, CA ${zip}`;
  const url = new URL(
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress",
  );
  url.search = new URLSearchParams({
    address: oneLine,
    benchmark: "Public_AR_Census2020",
    format: "json",
  });
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false, reason: "http_" + r.status };
    const data = await r.json();
    const m = data?.result?.addressMatches?.[0];
    if (!m) return { ok: false, reason: "not_found" };
    const matchedZip = String(m.addressComponents?.zip || "").slice(0, 5);
    const expected = area === "WeHo" ? WEHO_ZIPS : LA_ZIPS;
    return {
      ok: expected.has(matchedZip),
      matchedZip,
      matchedAddr: m.matchedAddress,
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

console.log("Verifying candidates against Census...\n");
const passed = { WeHo: [], LA: [] };

for (const c of candidates) {
  const v = await check(c.line1, c.zip, c.area);
  const tag = v.ok ? "✅" : "❌";
  const detail = v.ok ? `→ ${v.matchedZip}` : `(${v.reason})`;
  console.log(`${tag} [${c.area}] ${c.line1}, ${c.zip}  ${detail}`);
  if (v.ok) passed[c.area].push({ ...c, matched: v.matchedAddr });
}

console.log(
  `\n--- ${passed.WeHo.length} WeHo, ${passed.LA.length} LA passed ---`,
);
console.log("\nUse these in Postman:");
console.log(JSON.stringify(passed, null, 2));
