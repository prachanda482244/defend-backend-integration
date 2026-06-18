// utils/addressValidation.js
import { normalizeAddress } from "./normalizeAddress.js";

const CENSUS_URL =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

const ALLOWED_ZIPS = new Set(["90038", "90046", "90048", "90069"]);

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

/**
 * Calls the US Census geocoder.
 * Returns { ok: true, normalized, components, coordinates } on a hit,
 *         { ok: false, reason } otherwise.
 */
export async function validateUSAddress(oneLine) {
  const url = new URL(CENSUS_URL);
  url.search = new URLSearchParams({
    address: oneLine,
    benchmark: "Public_AR_Census2020",
    format: "json",
  });

  // Native fetch ignores { timeout }, so use AbortController for a real timeout.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

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

// Looks like a real US street line: leading house number + a street-type word.
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

/**
 * Wraps validateUSAddress with safe fallback handling.
 *
 * CRITICAL FIX (this is what stops the "806 E 80th St + 90069" bug):
 *
 *   - "not_found" is no longer treated as recoverable. If Census looked
 *     and didn't find the address, we trust that NEGATIVE answer and
 *     reject. The old code did the opposite — it forgave not_found and
 *     accepted on the user's typed ZIP, which is exactly how a bad
 *     South-LA street got paired with a West Hollywood ZIP.
 *
 *   - Only transient failures (timeout / network error / 5xx) are
 *     considered recoverable.
 *
 *   - Even on a transient failure, we DO NOT trust the user's typed ZIP.
 *     We retry Census with just "<street>, CA" (no city, no ZIP) and
 *     accept ONLY if Census itself returns a ZIP that is in our
 *     service area. If Census returns a different ZIP -> reject as a
 *     zip_mismatch. If the retry also fails transiently -> accept but
 *     mark needsReview so the order can be held for manual review.
 *
 * @param {string} oneLine  e.g. "8500 Santa Monica Blvd, West Hollywood, CA 90069"
 * @param {object} opts
 * @param {string} opts.postCode  raw postCode from the request
 * @param {boolean} opts.isLA     true when flag === "defentLA"
 * @param {string} opts.city      city string used to build oneLine
 * @param {string} opts.line1     raw street line from the request
 */
export async function validateAddressWithZipFallback(
  oneLine,
  { postCode, isLA, city, line1 },
) {
  const v = await validateUSAddress(oneLine);
  if (v.ok) return v;

  // Only forgive Census being temporarily unreachable.
  // "not_found" is a real negative answer — do NOT recover from it.
  const recoverable =
    v.reason === "timeout" ||
    v.reason === "network_error" ||
    (typeof v.reason === "string" && v.reason.startsWith("http_5"));

  if (!recoverable) return v;

  // Don't fall back for input that isn't even shaped like a street address.
  if (!looksLikeStreetAddress(line1)) return v;

  const zip5 = String(postCode || "").slice(0, 5);
  const expectedZipSet = isLA ? LA_ZIPS : ALLOWED_ZIPS;
  if (!expectedZipSet.has(zip5)) return v;

  // Independent confirmation: ask Census what ZIP this STREET is in,
  // without telling it the city or ZIP. If Census can answer and the
  // returned ZIP isn't in our area, reject.
  const retry = await validateUSAddress(`${line1}, CA`);
  if (retry.ok) {
    if (!expectedZipSet.has(retry.components.zip5)) {
      // Census found this street — at a DIFFERENT ZIP. Bad address.
      return {
        ok: false,
        reason: "zip_mismatch",
        components: retry.components,
      };
    }
    // Census found it and the ZIP IS in our area — trust Census's answer.
    return retry;
  }

  // Both Census calls failed transiently. Conservative accept, but
  // flag for review so the controller can hold sync.
  return {
    ok: true,
    fallback: true,
    needsReview: true,
    normalized: oneLine.toUpperCase(),
    components: {
      city: city || (isLA ? "Los Angeles" : "West Hollywood"),
      state: "CA",
      zip5,
    },
    coordinates: null,
  };
}

// Service-area gate. Trusts state + ZIP because the Census geocoder
// frequently mislabels West Hollywood addresses as "Los Angeles".
export function isWestHollywoodOK(components) {
  const stateOK = (components.state || "").toUpperCase() === "CA";
  const zipOK = ALLOWED_ZIPS.has(components.zip5 || "");
  return stateOK && zipOK;
}

export function isLosAngelesOK(components) {
  const stateOK = (components.state || "").toUpperCase() === "CA";
  const zipOK = LA_ZIPS.has(components.zip5 || "");
  return stateOK && zipOK;
}

// Strict variants kept available if you ever want exact-city enforcement.
export function isWestHollywoodStrict(components) {
  const cityOK = (components.city || "").toLowerCase() === "west hollywood";
  return cityOK && isWestHollywoodOK(components);
}

export function isLosAngelesStrict(components) {
  const cityOK = (components.city || "").toLowerCase() === "los angeles";
  return cityOK && isLosAngelesOK(components);
}

// More strict version that catches addresses that are too similar
export function areAddressLinesSame(line1, line2) {
  if (!line2) return false;

  const normalizedLine1 = normalizeAddress(line1);
  const normalizedLine2 = normalizeAddress(line2);

  // Direct equality check
  if (normalizedLine1 === normalizedLine2) return true;

  // Additional checks for common variations
  const removeCommonPrefixes = (str) => {
    return str
      .replace(/^(apt|apartment|unit|suite|ste|#|no|number)\s*/g, "")
      .replace(/^\d+\s*/g, ""); // Remove leading unit numbers
  };

  const cleanLine1 = removeCommonPrefixes(normalizedLine1);
  const cleanLine2 = removeCommonPrefixes(normalizedLine2);

  // Check if one contains the other (with some length threshold)
  const minLength = Math.min(cleanLine1.length, cleanLine2.length);
  if (minLength > 5) {
    if (cleanLine1.includes(cleanLine2) || cleanLine2.includes(cleanLine1)) {
      return true;
    }
  }

  return false;
}
