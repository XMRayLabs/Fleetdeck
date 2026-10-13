/** Bound each target independently so one noisy host cannot hide other results. */
export function reviewEvidence(job: Record<string, unknown>) {
    const targets = Array.isArray(job.targets) ? job.targets : [];
    const limit = Math.max(256, Math.min(8000, Math.floor(80000 / Math.max(1, targets.length) / 3)));
    const clip = (value: unknown) => {
        const text = typeof value === 'string' ? value : '';
        return text.length > limit ? text.slice(0, limit / 2) + '\n[OUTPUT TRUNCATED]\n' + text.slice(-Math.floor(limit / 2)) : text;
    };
    return { id:job.id, status:job.status, payload:job.payload, targets:targets.map(target => ({
        connectionId:target.connectionId, connectionName:target.connectionName,
        status:target.status, exitCode:target.exitCode,
        stdout:clip(target.stdout), stderr:clip(target.stderr), error:clip(target.error),
    })) };
}
