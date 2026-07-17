import { ApiResponse } from "./ApiResponse.js";

// utils/normalizeAddress.js
export const normalizeAddress = (s = "") =>
  s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\s\W_]+/g, " ")
    .trim()
    .replace(/\s+/g, "");

/* ++ DEDUPE HOLE FIX ++
 * "Apt 4", "Suite 4", "Unit 4", "#4", "Apt. 4" must all be ONE household.
 * Strip the LEADING designator word(s), keep the identifier. A line2 that
 * is ONLY designator words ("basement apt") is kept as-is. */
const UNIT_DESIGNATOR =
  /^(?:apartment|apt|suite|ste|unit|room|rm|number|num|no|hash)\s*/;

export const normalizeLine2 = (s = "") => {
  const spaced = String(s)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/#/g, " hash ") // "#4" -> " hash 4" so the regex can see it
    .replace(/[\s\W_]+/g, " ")
    .trim();

  let stripped = spaced;
  for (;;) {
    const next = stripped.replace(UNIT_DESIGNATOR, "");
    if (next === stripped) break;
    stripped = next;
  }

  const chosen = stripped.trim() || spaced;
  return chosen.replace(/\s+/g, "");
};
