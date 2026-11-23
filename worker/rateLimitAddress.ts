// Rate-limit buckets treat an IPv6 /64 as one source. A single subscriber or
// host normally controls the whole prefix, so per-address keys would let one
// machine rotate source addresses and bypass every per-source limit.
export function rateLimitAddress(ip: string | null | undefined): string {
  const value = (ip ?? "").trim();
  if (!value) return "unknown";
  if (!value.includes(":")) return value;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) return mapped[1];
  const halves = value.split("::");
  if (halves.length > 2) return value;
  const groups = (part: string) => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  // An embedded IPv4 suffix occupies two groups.
  const width = (parts: string[]) => parts.reduce((total, part) => total + (part.includes(".") ? 2 : 1), 0);
  const missing = 8 - width(head) - width(tail);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return value;
  const prefix = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail].slice(0, 4);
  if (!prefix.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) return value;
  return `${prefix.map((part) => parseInt(part, 16).toString(16)).join(":")}::/64`;
}
