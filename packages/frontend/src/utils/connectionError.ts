/** Extract only the public error fields, never stringify credential-bearing payloads. */
export function connectionError(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload || fallback;
  if (!payload || typeof payload !== 'object') return fallback;
  const value = payload as { message?: unknown; error?: unknown; code?: unknown };
  const message = typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : fallback;
  return typeof value.code === 'string' && !message.includes(value.code) ? `${value.code}: ${message}` : message;
}
