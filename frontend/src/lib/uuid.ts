// crypto.randomUUID() only exists in secure contexts (HTTPS or localhost).
// This dashboard is commonly served over plain HTTP to a bare IP (see
// install-master.sh), where it's simply absent — crypto.getRandomValues,
// unlike randomUUID, isn't restricted to secure contexts and is universally
// available, so build a v4 UUID from it by hand instead.
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
