export const normalizeAddress = (s = "") =>
  s
    .normalize("NFKD") // Unicode normalize
    .toLowerCase() // case-insensitive
    .replace(/[\s\W_]+/g, " ") // collapse all non-alnum to single space
    .trim() // trim ends
    .replace(/\s+/g, "");
