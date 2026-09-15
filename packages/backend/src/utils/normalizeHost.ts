import { isIP } from 'node:net';

/** Canonical IPv6 only: never interpret a username or guess an embedded port. */
export function normalizeHost(host: string): string {
    const trimmed = host.trim();
    const address = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
    const percent = address.indexOf('%');
    const base = percent < 0 ? address : address.slice(0, percent);
    const scope = percent < 0 ? '' : address.slice(percent);
    if (isIP(base) !== 6 || (scope && !/^%[a-zA-Z0-9_.-]+$/.test(scope))) return host;
    return new URL(`http://[${base}]/`).hostname.slice(1, -1) + scope;
}
