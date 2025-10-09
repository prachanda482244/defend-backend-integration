import { ApiResponse } from "./ApiResponse.js";

export const normalizeAddress = (s = "") =>
  s
    .normalize("NFKD") // Unicode normalize
    .toLowerCase() // case-insensitive
    .replace(/[\s\W_]+/g, " ") // collapse all non-alnum to single space
    .trim() // trim ends
    .replace(/\s+/g, "");

// validators/address.js
const ADDRESS_ALLOWED = /^[0-9A-Za-z\s#\-.,/]+$/;

export function validateStreetAddress(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!s) return { ok: false, error: "Street address is required" };
  if (!ADDRESS_ALLOWED.test(s))
    return { ok: false, error: "Address contains invalid characters" };
  if (/[#\-.,/]{2,}/.test(s))
    return { ok: false, error: "Address has invalid punctuation" };
  if (/[#\-.,/]$/.test(s))
    return { ok: false, error: "Address cannot end with punctuation" };
  return { ok: true, value: s };
}
