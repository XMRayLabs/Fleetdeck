/** Defense in depth: arbitrary business secrets still require human review. */
export function redact(text: string, known: string[] = []): string {
    let result = text;
    for (const secret of [...new Set(known)].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
    return result
        .replace(/-----BEGIN [^-]*(?:PRIVATE KEY(?: BLOCK)?|CERTIFICATE)-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[REDACTED KEY/CERTIFICATE]')
        .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/(["']?(?:authorization|proxy-authorization|set-cookie|cookie)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\r\n]+)/gi, '$1[REDACTED]')
        .replace(/(["']?(?:[\w-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*|pwd)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;&}\]]+)/gi, '$1[REDACTED]')
        .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[REDACTED TOKEN]')
        .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, '$1[REDACTED]@')
        .replace(/((?:--password|--token|--api-key|sshpass\s+-p)\s+)("[^"]*(?:"|$)|'[^']*(?:'|$)|\S+)/gi, '$1[REDACTED]');
}

/** Redact strings before serialization, preserving JSON structure and escaped secrets. */
export function redactValue(value: unknown, known: string[] = []): any {
    if (typeof value === 'string') return redact(value, known);
    if (Array.isArray(value)) return value.map(item => redactValue(item, known));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        /password|passwd|passphrase|secret|token|api[_-]?key|private[_-]?key|authorization|cookie/i.test(key) && item ? '[REDACTED]' : redactValue(item, known)]));
    return value;
}

/** Only release complete lines, with a guard for split known credentials. */
export function redactLive(text: string, known: string[] = []): string {
    const guard = Math.max(512, ...known.map(s=>s.length));
    const boundary = text.lastIndexOf('\n', Math.max(0,text.length-guard));
    if (boundary < 0) return '';
    const safe = redact(text,known);
    // Redaction can shorten text; hold the same suffix again, never cut an unredacted input prefix.
    return safe.slice(0,Math.max(0,safe.lastIndexOf('\n',Math.max(0,safe.length-guard))));
}

export function liveAnalysis(raw: string, known: string[]): string {
    const match = /"analysis"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
    if (!match) return '';
    try { return redactLive(JSON.parse('"'+match[1]+'"'),known); } catch { return ''; }
}
