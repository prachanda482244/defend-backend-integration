// utils/addressValidation.js
import { normalizeAddress } from "./normalizeAddress.js";

/* ==================================================================== *
 *  ADDRESS VALIDATION — municipality-based, NOT zip-based.
 *
 *  ── THE RULE ────────────────────────────────────────────────────────
 *  Ask Census what city the ADDRESS is actually in. Decide on that.
 *  The ZIP the customer typed is never part of the decision — it is only
 *  a hint we pass to Census to help it find the address, and if the hint
 *  is wrong we drop it and ask again.
 *
 *      Defent WEHO  ->  must be in the City of West Hollywood.
 *      Defent LA    ->  must be in the City of Los Angeles.
 *
 *  ── WHY ZIP CANNOT WORK ─────────────────────────────────────────────
 *  ZIPs are USPS delivery routes. They do not respect city boundaries.
 *  90046 covers a large slice of the City of LA (Hollywood Hills, Laurel
 *  Canyon) AND part of West Hollywood. 90048 straddles WeHo and LA's
 *  Beverly Grove. 90038 is mostly Hollywood, i.e. City of LA.
 *
 *  So "zip in {90038,90046,90048,90069}" lets City-of-LA residents into
 *  the West Hollywood program. There is already an example in the DB:
 *      "1725 CAMINO PALMERO ST, ..., 90046"
 *  Camino Palmero is in Hollywood = City of Los Angeles, not West
 *  Hollywood. It passed only because 90046 is on the allowed list.
 *
 *  ── WHAT WE USE INSTEAD ─────────────────────────────────────────────
 *  Census's `geographies` endpoint returns an "Incorporated Places"
 *  layer — the actual municipal boundary the address falls inside:
 *
 *      Incorporated Places: { NAME: "West Hollywood city", GEOID: ... }
 *      Incorporated Places: { NAME: "Los Angeles city",    GEOID: ... }
 *
 *  West Hollywood is a separate incorporated city (since 1984) and has
 *  never been part of the City of Los Angeles — so this layer answers
 *  the question exactly. `geographies` also returns everything the old
 *  `locations` endpoint returned, so this is still ONE call, not two.
 *
 *  (The old code deliberately trusted ZIP over Census's `city` field
 *   because that field is a POSTAL city name and does mislabel WeHo
 *   addresses. That was a fair workaround. Incorporated Places is a
 *   different field: a boundary, not a mailing label.)
 * ==================================================================== */

const CENSUS_BASE = "https://geocoding.geo.census.gov/geocoder";

/* Current address ranges + current municipal boundaries. */
const BENCHMARK = process.env.CENSUS_BENCHMARK || "Public_AR_Current";
const VINTAGE = process.env.CENSUS_VINTAGE || "Current_Current";
const CENSUS_TIMEOUT_MS = Number(process.env.CENSUS_TIMEOUT_MS || 8000);

/* Fail CLOSED when Census can't be reached. An address nobody verified
   does not get a free device. Turn on only during a long outage. */
const ALLOW_UNVERIFIED = process.env.ALLOW_UNVERIFIED_ADDRESS === "true";

/* Target municipalities. Compared case-insensitively after stripping the
   Census suffix ("West Hollywood city" -> "west hollywood"). */
const WEHO_PLACE = (process.env.WEHO_PLACE || "West Hollywood").toLowerCase();
const LA_PLACE = (process.env.LA_PLACE || "Los Angeles").toLowerCase();

/* Kept ONLY as a safety net for the rare case where Census returns a
   match with no Incorporated Places layer. Never the primary check. */
const WEHO_ZIPS = new Set(["90038", "90046", "90048", "90069"]);

/* Rough LA-County box. Rejects a same-named street elsewhere in
   California when we have had to drop the city from the query. */
const LA_BOX = { minLat: 33.6, maxLat: 34.9, minLon: -118.95, maxLon: -117.6 };

/* ---- Census place-name suffix stripping ---------------------------- *
 * Census formats place names as "<Name> city" / "<Name> town" / etc.
 * Verified against live responses: "Washington city", "New York city",
 * "Westminster city", "Duncan town".                                    */
function normalizePlaceName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+(city|town|village|borough|municipality|cdp)$/, "")
    .trim();
}

const houseNumberOf = (s) =>
  (String(s || "")
    .trim()
    .match(/^(\d+)/) || [])[1] || null;

/**
 * ONE Census call. Returns everything needed to decide.
 *
 *   { ok: true,
 *     normalized,                    // "1725 CAMINO PALMERO ST, LOS ANGELES, CA, 90046"
 *     components: {city,state,zip5}, // Census's POSTAL city + zip
 *     place,                         // "los angeles"  <- THE MUNICIPALITY. This decides.
 *     placeRaw,                      // "Los Angeles city"
 *     placeGeoid,
 *     coordinates: {x,y} }
 *
 *   { ok: false, reason: "not_found" | "timeout" | "network_error" | "http_5xx" }
 */
export async function geocodeCensus(oneLine, { wantHouseNumber = null } = {}) {
  const url = new URL(`${CENSUS_BASE}/geographies/onelineaddress`);
  url.search = new URLSearchParams({
    address: oneLine,
    benchmark: BENCHMARK,
    vintage: VINTAGE,
    format: "json",
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CENSUS_TIMEOUT_MS);

  let r;
  try {
    r = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    return {
      ok: false,
      reason: e?.name === "AbortError" ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) return { ok: false, reason: "http_" + r.status };

  let data;
  try {
    data = await r.json();
  } catch {
    return { ok: false, reason: "network_error" };
  }

  const matches = data?.result?.addressMatches || [];
  if (!matches.length) return { ok: false, reason: "not_found" };

  /* Census can return several matches (e.g. "1600 Pennsylvania Ave" gives
     both the NW and the SE one). Prefer the match whose house number is
     the one the customer actually typed. */
  const best =
    (wantHouseNumber &&
      matches.find(
        (m) => houseNumberOf(m.matchedAddress) === wantHouseNumber,
      )) ||
    matches[0];

  const comp = best.addressComponents || {};
  const geo = best.geographies || {};
  const placeRow = geo["Incorporated Places"]?.[0] || null;

  return {
    ok: true,
    normalized: best.matchedAddress || "",
    components: {
      city: comp.city || "",
      state: comp.state || "",
      zip5: String(comp.zip || "").slice(0, 5),
    },
    place: normalizePlaceName(placeRow?.NAME), // <- the decision field
    placeRaw: placeRow?.NAME || "",
    placeGeoid: placeRow?.GEOID || "",
    coordinates: best.coordinates || null,
  };
}

/* Back-compat: old export name, same contract, richer payload. */
export const validateUSAddress = (oneLine) => geocodeCensus(oneLine);

function looksLikeStreetAddress(line1) {
  const s = String(line1 || "")
    .trim()
    .toLowerCase();
  const hasHouseNumber = /^\d+\s+\S+/.test(s);
  const hasStreetType =
    /\b(st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|pl|place|way|ter|terrace|cir|circle|hwy|highway|pkwy|parkway)\b/.test(
      s,
    );
  return hasHouseNumber && hasStreetType;
}

function inLAArea(coords) {
  if (!coords) return false;
  const lon = coords.x;
  const lat = coords.y;
  return (
    lat >= LA_BOX.minLat &&
    lat <= LA_BOX.maxLat &&
    lon >= LA_BOX.minLon &&
    lon <= LA_BOX.maxLon
  );
}

/* Dedup key, Census-shaped, identical on every code path. */
const censusShaped = ({ line1, city, zip5 }) =>
  `${line1}, ${city}, CA, ${zip5}`.toUpperCase();

/* ==================================================================== *
 *  validateAddressWithZipFallback(oneLine, { postCode, isLA, city, line1 })
 *
 *  Name kept so the controller's import doesn't change — but it is no
 *  longer a "zip fallback". It is an escalating geocode, and the typed
 *  ZIP never decides anything.
 *
 *  ESCALATION (stop at the first hit):
 *    1. "<line1>, <city>, CA <zip>"   full hint — best hit rate
 *    2. "<line1>, <city>, CA"         drop the ZIP  -> handles "address
 *                                     is right, customer typed a bad ZIP"
 *    3. "<line1>, CA"                 drop the city -> handles Census
 *                                     parser quirks with city names
 *
 *  Whatever hits, the DECISION is made on `place` (Incorporated Places).
 * ==================================================================== */
export async function validateAddressWithZipFallback(
  oneLine,
  { postCode, isLA, city, line1 },
) {
  const zip5 = String(postCode || "").slice(0, 5);
  const wantNum = houseNumberOf(line1);

  /* The "city" in a geocoder query is a POSTAL label, and TIGER keys
   * street ranges to postal city names. USPS's primary postal city for
   * eastern-WeHo ZIPs (notably 90046) is "Los Angeles" — "West Hollywood"
   * is only an alias. So a query hinting "West Hollywood" can miss a
   * street Census files under "Los Angeles" even though the MUNICIPAL
   * boundary (the thing we decide on) is genuinely West Hollywood.
   * Example that failed all three old attempts: "1145 N Ogden Dr".
   *
   * Extra rungs are safe: the service-area gate still decides on the
   * Incorporated Places layer, so a looser query can never let a
   * City-of-LA address into the WeHo program — it only helps Census
   * FIND the address so the boundary check can run at all.
   *
   * `needsBox`: attempts with neither city nor zip can match a
   * same-named street anywhere in CA, so require LA-area coordinates. */
  const attempts = [
    { q: oneLine, needsBox: false }, // "line1, city, CA zip"
    { q: `${line1}, ${city}, CA`, needsBox: false }, // no ZIP
    ...(zip5
      ? [{ q: `${line1}, CA ${zip5}`, needsBox: false }] // ZIP only, no city label
      : []),
    ...(!isLA
      ? [{ q: `${line1}, Los Angeles, CA`, needsBox: false }] // WeHo street filed under LA postal city
      : []),
    { q: `${line1}, CA`, needsBox: true }, // last resort: no ZIP, no city
  ];

  let hit = null;
  let lastFail = null;

  for (const attempt of attempts) {
    const res = await geocodeCensus(attempt.q, { wantHouseNumber: wantNum });

    if (!res.ok) {
      lastFail = res;
      // Transient failure means Census is unwell — escalating won't help.
      if (res.reason !== "not_found") break;
      continue; // not_found -> try a looser query
    }

    if (attempt.needsBox && !inLAArea(res.coordinates)) {
      lastFail = { ok: false, reason: "not_found" };
      continue;
    }

    hit = res;
    break;
  }

  if (!hit) {
    const reason = lastFail?.reason || "not_found";
    const transient = reason !== "not_found";

    if (!transient) return { ok: false, reason: "not_found" };

    /* Census unreachable. FAIL CLOSED — we will not guess at someone's
       address using a ZIP they typed themselves. */
    if (!ALLOW_UNVERIFIED || !looksLikeStreetAddress(line1)) {
      return { ok: false, reason: "unverifiable", transient: true };
    }

    /* Escape hatch: accept but flag. createOrder HOLDS these (see the
       needsReview guard there) — nothing ships unverified. */
    return {
      ok: true,
      fallback: true,
      needsReview: true,
      normalized: censusShaped({ line1, city, zip5 }),
      components: { city, state: "CA", zip5 },
      place: "",
      placeRaw: "",
      coordinates: null,
    };
  }

  /* Census matched — but is it the building they typed? Census geocodes
     against TIGER street RANGES and is documented as forgiving with
     non-standard input, so a match does not by itself mean it matched
     YOUR house number. */
  const gotNum = houseNumberOf(hit.normalized);
  if (wantNum && gotNum && wantNum !== gotNum) {
    return {
      ok: false,
      reason: "house_number_mismatch",
      matched: hit.normalized,
      components: hit.components,
    };
  }

  return hit;
}

/* ==================================================================== *
 *  SERVICE-AREA GATES — the ADDRESS decides, not the ZIP.
 *
 *  Accepts the full result object (preferred), or a bare `components`
 *  object for any legacy caller.
 * ==================================================================== */
function gate(result, targetPlace, zipSafetyNet) {
  if (!result) return false;

  // Full result -> use the municipality. This is the real check.
  if (typeof result.place === "string" && result.place) {
    return result.place === targetPlace;
  }

  /* No Incorporated Places layer came back (unincorporated land, or a
     response shape we didn't expect). Rather than silently accept, fall
     back to the OLD state+zip behaviour. The controller logs this so you
     can see how often it actually happens — expected: almost never. */
  const c = result.components || result;
  const stateOK = String(c?.state || "").toUpperCase() === "CA";
  if (!stateOK) return false;
  return zipSafetyNet ? zipSafetyNet(String(c?.zip5 || "")) : false;
}

export function isWestHollywoodOK(result) {
  return gate(result, WEHO_PLACE, (z) => WEHO_ZIPS.has(z));
}

/* City of Los Angeles. Your FAQ says "FREE DEFENT ONE PROGRAM · CITY OF
   LOS ANGELES", so the City is the correct boundary — not LA County, and
   not all of California. Override with LA_PLACE if that ever changes. */
export function isLosAngelesOK(result) {
  return gate(result, LA_PLACE, () => false);
}

/* The old "strict" variants added a POSTAL-city check on top of ZIP. The
   main gates are municipality-based now, so strict === normal. Kept as
   aliases so nothing that imports them breaks. */
export const isWestHollywoodStrict = isWestHollywoodOK;
export const isLosAngelesStrict = isLosAngelesOK;

/* Human-readable reason, for the customer message and the error log. */
export function serviceAreaReason(result, isLA) {
  const want = isLA ? "Los Angeles" : "West Hollywood";
  if (!result?.placeRaw) {
    return `Could not determine the city for this address (expected ${want}).`;
  }
  return `That address is in ${result.placeRaw}, not the City of ${want}.`;
}

// --------------------------------------------------------------------
export function areAddressLinesSame(line1, line2) {
  if (!line2) return false;

  const a = normalizeAddress(line1);
  const b = normalizeAddress(line2);
  if (a === b) return true;

  const strip = (str) =>
    str
      .replace(/^(apt|apartment|unit|suite|ste|#|no|number)\s*/g, "")
      .replace(/^\d+\s*/g, "");

  const ca = strip(a);
  const cb = strip(b);

  if (Math.min(ca.length, cb.length) > 5) {
    if (ca.includes(cb) || cb.includes(ca)) return true;
  }
  return false;
}
