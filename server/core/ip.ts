/**
 * Client addresses for rate limiting (SPEC §10.9). Pure; addresses are never stored.
 *
 * - Behind a reverse proxy (TRUST_PROXY=1) the client is the RIGHTMOST X-Forwarded-For entry: a proxy that appends
 *   (nginx `$proxy_add_x_forwarded_for`, Caddy, Traefik) puts the peer it saw last, and everything before it is
 *   whatever the client sent. One trusted hop is assumed; behind a chain of proxies the last one must overwrite the
 *   header instead of appending to it.
 * - Limits key on {@link ipKey}: an IPv4 address as is, an IPv6 address by its /64 prefix (one subscriber usually
 *   owns a whole /64, so per-address keys would hand out 2^64 buckets), IPv4-mapped IPv6 as the IPv4 address.
 */

/** The client address from a forwarded header (rightmost non-empty entry), or null. */
export function forwardedClient(header: string | null | undefined): string | null {
  if (!header) return null;
  const parts = header.split(',');
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!.trim();
    if (p !== '') return p;
  }
  return null;
}

/** Rate-limit key of the request's client: see the header. `socketAddress` is the TCP peer. */
export function clientKey(forwarded: string | null | undefined, socketAddress: string | null | undefined, trustProxy: boolean): string {
  const fromProxy = trustProxy ? forwardedClient(forwarded) : null;
  return ipKey(fromProxy ?? socketAddress ?? 'unknown');
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Normalised limiter key of one address (see the header); anything unparsable is returned lowercased and capped. */
export function ipKey(raw: string): string {
  let addr = raw.trim().toLowerCase();
  // `[v6]:port` and `v4:port` as some proxies write them.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(addr);
  if (bracketed) addr = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(addr)) addr = addr.slice(0, addr.lastIndexOf(':'));
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  if (IPV4.test(addr)) return addr;
  const groups = expandIpv6(addr);
  if (!groups) return addr.slice(0, 64);
  // ::ffff:a.b.c.d (IPv4-mapped) is an IPv4 client on a dual-stack socket.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/** The eight 16-bit groups of an IPv6 address (embedded IPv4 tail allowed), or null when it is not one. */
function expandIpv6(addr: string): number[] | null {
  if (!addr.includes(':') || !/^[0-9a-f:.]+$/.test(addr)) return null;
  const halves = addr.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    const parts = s.split(':');
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (i === parts.length - 1 && p.includes('.')) {
        const m = IPV4.exec(p);
        if (!m) return null;
        const b = m.slice(1).map(Number);
        if (b.some((x) => x > 255)) return null;
        out.push((b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}
