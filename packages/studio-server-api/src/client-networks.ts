import net from 'node:net';
import ipaddr from 'ipaddr.js';

/** Strict IP literals only: no abbreviated/octal IPv4, zone IDs or DNS names. */
export function normalizeClientAddress(value: string): string | null {
  if (!net.isIP(value) || value.includes('%')) return null;
  return ipaddr.process(value).toString();
}

export function normalizeClientNetwork(value: string): string {
  const parts = value.trim().split('/');
  const literal = parts[0] ?? '';
  if (parts.length > 2 || !net.isIP(literal) || literal.includes('%')) {
    throw new Error('Enter an IP address or CIDR network, not a hostname or URL.');
  }
  const address = ipaddr.parse(literal);
  if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
    if (parts.length > 1) throw new Error('Use IPv4 notation for IPv4-mapped networks.');
    return ipaddr.process(literal).toString();
  }
  if (parts.length === 1) return address.toString();
  const rawPrefix = parts[1]!;
  const prefix = Number(rawPrefix);
  const maximum = address.kind() === 'ipv4' ? 32 : 128;
  if (!/^\d+$/.test(rawPrefix) || prefix < 1 || prefix > maximum) {
    throw new Error(`Network prefix must be between 1 and ${maximum}; universal networks are not allowed.`);
  }
  const bytes = address.toByteArray().map((byte, index) => {
    const bits = Math.max(0, Math.min(8, prefix - index * 8));
    return byte & (256 - 2 ** (8 - bits));
  });
  return `${ipaddr.fromByteArray(bytes).toString()}/${prefix}`;
}

export function clientMatchesNetworks(address: string, networks: readonly string[]): boolean {
  const normalized = normalizeClientAddress(address);
  if (!normalized) return false;
  const parsed = ipaddr.parse(normalized);
  return networks.some((network) => {
    const [range, prefix] = network.includes('/')
      ? ipaddr.parseCIDR(network)
      : [ipaddr.parse(network), network.includes(':') ? 128 : 32] as const;
    return parsed.kind() === range.kind() && parsed.match(range, prefix);
  });
}
