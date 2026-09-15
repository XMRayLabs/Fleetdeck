/** Brackets distinguish an IPv6 host from the separate connection port. */
export function formatConnectionAddress(connection: { username?: string; host: string; port: number }): string {
  const host = connection.host.includes(':') && !connection.host.startsWith('[')
    ? `[${connection.host}]` : connection.host;
  return `${connection.username ? connection.username + '@' : ''}${host}:${connection.port}`;
}
