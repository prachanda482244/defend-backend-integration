import { ApiResponse } from "./ApiResponse.js";

// utils/normalizeAddress.js
export const normalizeAddress = (s = "") =>
  s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\s\W_]+/g, " ")
    .trim()
    .replace(/\s+/g, "");

export const normalizeLine2 = (s = "") => normalizeAddress(s); // separate for clarity

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
