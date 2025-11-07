// validators/address.js
const LINE_ALLOWED = /^[0-9A-Za-z\s#\-.,/]+$/;

export function validateAddressLine1(raw) {
  const s = String(raw || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!s) return { ok: false, error: "Address Line 1 is required" };
  if (!LINE_ALLOWED.test(s))
    return { ok: false, error: "Address contains invalid characters" };
  if (/[#\-.,/]{2,}/.test(s))
    return { ok: false, error: "Invalid punctuation" };
  if (/[#\-.,/]$/.test(s))
    return { ok: false, error: "Cannot end with punctuation" };
  return { ok: true, value: s };
}

export function validateAddressLine2(raw) {
  // Line 2 is optional. If provided, allow apt/suite/unit/building info.
  const s0 = String(raw || "").trim();
  if (!s0) return { ok: true, value: "" }; // empty is fine
  const s = s0.replace(/\s+/g, " ");
  if (!LINE_ALLOWED.test(s))
    return { ok: false, error: "Address Line 2 contains invalid characters" };
  if (/[#\-.,/]{2,}/.test(s))
    return { ok: false, error: "Address Line 2 has invalid punctuation" };
  if (/[#\-.,/]$/.test(s))
    return { ok: false, error: "Address Line 2 cannot end with punctuation" };
  return { ok: true, value: s };
}
