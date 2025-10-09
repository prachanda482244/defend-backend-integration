const CENSUS_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

const ALLOWED_ZIPS = new Set(["90038", "90046", "90048", "90069"]);

export async function validateUSAddress(oneLine) {
  const url = new URL(CENSUS_URL);
  url.search = new URLSearchParams({
    address: oneLine,
    benchmark: "Public_AR_Census2020",
    format: "json",
  });

  const r = await fetch(url, { timeout: 8000 });
  if (!r.ok) return { ok: false, reason: "http_" + r.status };

  const data = await r.json();
  const match = data?.result?.addressMatches?.[0];
  if (!match) return { ok: false, reason: "not_found" };

  const comp = match.addressComponents || {};
  const zip5 = String(comp.zip || "").slice(0, 5);
  const city = comp.city || "";
  const state = comp.state || "";
  const normalized = match.matchedAddress || "";

  return {
    ok: true,
    normalized,
    components: { city, state, zip5 },
    coordinates: match.coordinates || null,
  };
}

// Optional gate for West Hollywood + ZIPs
export function isWestHollywoodOK(components) {
  const cityOK = (components.city || "").toLowerCase() === "west hollywood";
  const stateOK = (components.state || "").toUpperCase() === "CA";
  const zipOK = ALLOWED_ZIPS.has(components.zip5 || "");
  return cityOK && stateOK && zipOK;
}
