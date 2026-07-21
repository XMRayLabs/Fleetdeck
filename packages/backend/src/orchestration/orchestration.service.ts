import fs from 'fs';
import path from 'path';
import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import { v4 as uuidv4 } from 'uuid';
import { allDb, getDb, getDbInstance, runDb } from '../database/connection';
import { decrypt, encrypt } from '../utils/crypto';
import * as SshService from '../services/ssh.service';
import { AuditLogService } from '../audit/audit.service';

export type JobStatus = 'queued' | 'running' | 'success' | 'partial' | 'failed' | 'cancelled';
export type TargetStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';

interface ConnectionSnapshot {
    id: number;
    name: string | null;
    host: string;
    type: string;
    auth_method: 'password' | 'key';
    credential_mode: 'saved' | 'prompt';
}

interface JobRow {
    id: string;
    name: string;
    type: 'command' | 'upload';
    status: JobStatus;
    target_count: number;
    completed_count: number;
    success_count: number;
    failed_count: number;
    concurrency: number;
    timeout_seconds: number;
    stop_on_error: number;
    encrypted_payload: string;
    payload_summary: string;
    created_by: number | null;
    created_by_name?: string | null;
    cancel_requested: number;
    created_at: number;
    started_at: number | null;
    finished_at: number | null;
    updated_at: number;
}

interface TargetRow {
    id: number;
    job_id: string;
    connection_id: number | null;
    connection_name: string;
    host: string;
    status: TargetStatus;
    exit_code: number | null;
    encrypted_stdout: string | null;
    encrypted_stderr: string | null;
    error: string | null;
    started_at: number | null;
    finished_at: number | null;
    duration_ms: number | null;
}

export interface CommandJobInput {
    name?: string;
    targetIds: number[];
    commands: string[];
    concurrency?: number;
    timeoutSeconds?: number;
    stopOnError?: boolean;
    recordOutput?: boolean;
    ephemeralCredentials?: Record<string, SshService.EphemeralCredentials>;
}

export interface UploadFileInput {
    originalName: string;
    storedPath: string;
    size: number;
}

export interface UploadJobInput {
    name?: string;
    targetIds: number[];
    files: UploadFileInput[];
    remotePath: string;
    overwrite?: boolean;
    concurrency?: number;
    timeoutSeconds?: number;
    ephemeralCredentials?: Record<string, SshService.EphemeralCredentials>;
}

interface CommandPayload {
    kind: 'command';
    commands: string[];
    recordOutput: boolean;
}

interface UploadPayload {
    kind: 'upload';
    files: UploadFileInput[];
    remotePath: string;
    overwrite: boolean;
}

export interface PlaybookCommandExecutionStep {
    id: string;
    name: string;
    type: 'command';
    command: string;
    continueOnError: boolean;
}

export interface PlaybookUploadExecutionStep {
    id: string;
    name: string;
    type: 'upload';
    files: UploadFileInput[];
    remotePath: string;
    overwrite: boolean;
    continueOnError: boolean;
}

export type PlaybookExecutionStep = PlaybookCommandExecutionStep | PlaybookUploadExecutionStep;

interface PlaybookPayload {
    kind: 'playbook';
    playbookId: string;
    revision: number;
    steps: PlaybookExecutionStep[];
}

type JobPayload = CommandPayload | UploadPayload | PlaybookPayload;

const auditLogService = new AuditLogService();
const activeClients = new Map<string, Set<Client>>();
const activeJobs = new Set<string>();
const jobCredentials = new Map<string, Map<number, SshService.EphemeralCredentials>>();
// Playbook variables can contain passwords or tokens. Keep every supplied value
// in memory only so it never appears in SQLite or audit logs.
const jobPlaybookVariables = new Map<string, Record<string, string>>();
const jobPlaybookRedactions = new Map<string, string[]>();
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DATA_ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..', '..', 'data');
export const uploadStagingDirectory = path.join(DATA_ROOT, 'job-uploads');

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const normalizeTargetIds = (targetIds: unknown): number[] => {
    if (!Array.isArray(targetIds)) throw new Error('targetIds must be an array.');
    const ids = [...new Set(targetIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
    if (ids.length === 0) throw new Error('Please select at least one target server.');
    if (ids.length > 200) throw new Error('A single job can target at most 200 servers.');
    return ids;
};

const normalizeEphemeralCredentials = (
    targets: ConnectionSnapshot[],
    rawCredentials: unknown,
): Map<number, SshService.EphemeralCredentials> => {
    if (rawCredentials !== undefined && rawCredentials !== null && (typeof rawCredentials !== 'object' || Array.isArray(rawCredentials))) {
        throw new Error('ephemeralCredentials must be an object keyed by connection ID.');
    }

    const source = (rawCredentials || {}) as Record<string, unknown>;
    const normalized = new Map<number, SshService.EphemeralCredentials>();
    for (const target of targets) {
        if (target.credential_mode !== 'prompt') continue;
        const raw = source[String(target.id)];
        if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
            throw new Error(`Invalid temporary credentials for ${target.name || target.host}.`);
        }
        const candidate = (raw || {}) as Record<string, unknown>;
        if (candidate.password !== undefined && typeof candidate.password !== 'string') {
            throw new Error(`Temporary password for ${target.name || target.host} must be text.`);
        }
        if (candidate.passphrase !== undefined && typeof candidate.passphrase !== 'string') {
            throw new Error(`Temporary key passphrase for ${target.name || target.host} must be text.`);
        }
        const password = candidate.password as string | undefined;
        const passphrase = candidate.passphrase as string | undefined;
        if ((password?.length || 0) > 4096 || (passphrase?.length || 0) > 4096) {
            throw new Error(`Temporary credentials for ${target.name || target.host} exceed 4,096 characters.`);
        }
        if (target.auth_method === 'password' && !password) {
            throw new Error(`${target.name || target.host} requires a password for this job.`);
        }
        normalized.set(target.id, { password, passphrase });
    }
    return normalized;
};

const getTargetSnapshots = async (targetIds: number[]): Promise<ConnectionSnapshot[]> => {
    const db = await getDbInstance();
    const placeholders = targetIds.map(() => '?').join(',');
    const rows = await allDb<ConnectionSnapshot>(
        db,
        `SELECT id, name, host, type, auth_method, credential_mode FROM connections WHERE id IN (${placeholders})`,
        targetIds,
    );
    if (rows.length !== targetIds.length) {
        throw new Error('One or more selected servers no longer exist. Refresh the server list and try again.');
    }
    const unsupported = rows.filter(row => row.type !== 'SSH');
    if (unsupported.length > 0) {
        throw new Error(`Batch jobs currently require SSH targets. Unsupported: ${unsupported.map(row => row.name || row.host).join(', ')}`);
    }
    const rowById = new Map(rows.map(row => [row.id, row]));
    return targetIds.map(id => rowById.get(id) as ConnectionSnapshot);
};

const createJob = async (
    name: string,
    type: 'command' | 'upload',
    targets: ConnectionSnapshot[],
    payload: JobPayload,
    summary: Record<string, unknown>,
    concurrency: number,
    timeoutSeconds: number,
    stopOnError: boolean,
    createdBy: number | null,
    username?: string,
    ephemeralCredentials?: Record<string, SshService.EphemeralCredentials>,
    runtimeVariables?: Record<string, string>,
    redactedValues?: string[],
): Promise<string> => {
    const transientCredentials = normalizeEphemeralCredentials(targets, ephemeralCredentials);
    const db = await getDbInstance();
    const id = uuidv4();
    const timestamp = nowSeconds();
    await runDb(
        db,
        `INSERT INTO orchestration_jobs (
            id, name, type, status, target_count, concurrency, timeout_seconds,
            stop_on_error, encrypted_payload, payload_summary, created_by,
            created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            id,
            name,
            type,
            targets.length,
            concurrency,
            timeoutSeconds,
            stopOnError ? 1 : 0,
            encrypt(JSON.stringify(payload)),
            JSON.stringify(summary),
            createdBy,
            timestamp,
            timestamp,
        ],
    );

    for (const target of targets) {
        await runDb(
            db,
            `INSERT INTO orchestration_job_targets (
                job_id, connection_id, connection_name, host, status
            ) VALUES (?, ?, ?, ?, 'queued')`,
            [id, target.id, target.name || target.host, target.host],
        );
    }

    await auditLogService.logAction('ORCHESTRATION_JOB_CREATED', {
        jobId: id,
        jobName: name,
        type,
        targetCount: targets.length,
        userId: createdBy,
        username,
        ...summary,
    });
    if (transientCredentials.size > 0) jobCredentials.set(id, transientCredentials);
    if (runtimeVariables && Object.keys(runtimeVariables).length > 0) jobPlaybookVariables.set(id, runtimeVariables);
    if (redactedValues?.length) jobPlaybookRedactions.set(id, [...new Set(redactedValues.filter(Boolean))]);
    setImmediate(() => runJob(id).catch(error => console.error(`[Orchestration] Job ${id} failed unexpectedly:`, error)));
    return id;
};

export const createCommandJob = async (
    input: CommandJobInput,
    createdBy: number | null,
    username?: string,
): Promise<string> => {
    const targetIds = normalizeTargetIds(input.targetIds);
    if (!Array.isArray(input.commands)) throw new Error('commands must be an array.');
    const commands = input.commands.map(command => String(command).trim()).filter(Boolean);
    if (commands.length === 0) throw new Error('Please enter at least one command.');
    if (commands.length > 100) throw new Error('A single job can contain at most 100 commands.');
    if (commands.some(command => command.length > 32000)) throw new Error('A command cannot exceed 32,000 characters.');

    const targets = await getTargetSnapshots(targetIds);
    const concurrency = clampInteger(input.concurrency, 5, 1, 20);
    const timeoutSeconds = clampInteger(input.timeoutSeconds, 300, 5, 3600);
    const name = String(input.name || '').trim().slice(0, 120) || `批量命令 · ${new Date().toLocaleString('zh-CN')}`;
    return createJob(
        name,
        'command',
        targets,
        { kind: 'command', commands, recordOutput: input.recordOutput !== false },
        { commandCount: commands.length, recordOutput: input.recordOutput !== false },
        concurrency,
        timeoutSeconds,
        input.stopOnError !== false,
        createdBy,
        username,
        input.ephemeralCredentials,
    );
};

export const createUploadJob = async (
    input: UploadJobInput,
    createdBy: number | null,
    username?: string,
): Promise<string> => {
    const targetIds = normalizeTargetIds(input.targetIds);
    const remotePath = String(input.remotePath || '').trim();
    if (!remotePath || remotePath.length > 2048) throw new Error('Please provide a valid remote path.');
    if (!Array.isArray(input.files) || input.files.length === 0) throw new Error('Please choose at least one file.');
    if (input.files.length > 20) throw new Error('A single job can upload at most 20 files.');

    const targets = await getTargetSnapshots(targetIds);
    const concurrency = clampInteger(input.concurrency, 3, 1, 10);
    const timeoutSeconds = clampInteger(input.timeoutSeconds, 900, 10, 7200);
    const name = String(input.name || '').trim().slice(0, 120) || `文件分发 · ${new Date().toLocaleString('zh-CN')}`;
    return createJob(
        name,
        'upload',
        targets,
        { kind: 'upload', files: input.files, remotePath, overwrite: input.overwrite !== false },
        { fileCount: input.files.length, totalBytes: input.files.reduce((sum, file) => sum + file.size, 0), remotePath },
        concurrency,
        timeoutSeconds,
        true,
        createdBy,
        username,
        input.ephemeralCredentials,
    );
};

export const createPlaybookJob = async (input: {
    playbookId: string;
    playbookName: string;
    revision: number;
    targetIds: number[];
    steps: PlaybookExecutionStep[];
    concurrency?: number;
    timeoutSeconds?: number;
    stopOnError?: boolean;
    ephemeralCredentials?: Record<string, SshService.EphemeralCredentials>;
    runtimeVariables?: Record<string, string>;
    redactedValues?: string[];
}, createdBy: number | null, username?: string): Promise<string> => {
    const targetIds = normalizeTargetIds(input.targetIds);
    if (!Array.isArray(input.steps) || input.steps.length === 0) throw new Error('The playbook has no executable steps.');
    if (input.steps.length > 100) throw new Error('A playbook can execute at most 100 steps.');
    const targets = await getTargetSnapshots(targetIds);
    const concurrency = clampInteger(input.concurrency, 5, 1, 20);
    const timeoutSeconds = clampInteger(input.timeoutSeconds, 900, 10, 7200);
    const fileCount = input.steps.reduce((sum, step) => sum + (step.type === 'upload' ? step.files.length : 0), 0);
    return createJob(
        `${input.playbookName} · r${input.revision}`.slice(0, 120),
        'command',
        targets,
        { kind: 'playbook', playbookId: input.playbookId, revision: input.revision, steps: input.steps },
        { source: 'playbook', playbookId: input.playbookId, revision: input.revision, stepCount: input.steps.length, fileCount },
        concurrency,
        timeoutSeconds,
        input.stopOnError !== false,
        createdBy,
        username,
        input.ephemeralCredentials,
        input.runtimeVariables,
        input.redactedValues,
    );
};

const decryptPayload = (job: JobRow): JobPayload => JSON.parse(decrypt(job.encrypted_payload)) as JobPayload;

const appendLimited = (chunks: Buffer[], chunk: Buffer, state: { size: number; truncated: boolean }): void => {
    if (state.size >= MAX_OUTPUT_BYTES) {
        state.truncated = true;
        return;
    }
    const remaining = MAX_OUTPUT_BYTES - state.size;
    chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
    state.size += Math.min(chunk.length, remaining);
    if (chunk.length > remaining) state.truncated = true;
};

const execScript = (
    client: Client,
    commands: string[],
    stopOnError: boolean,
    timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => new Promise((resolve, reject) => {
    const script = `${stopOnError ? 'set -e\n' : ''}${commands.join('\n')}`;
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutState = { size: 0, truncated: false };
    const stderrState = { size: 0, truncated: false };
    let streamRef: ClientChannel | null = null;

    const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { streamRef?.close(); } catch { /* connection cleanup follows */ }
        reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);

    client.exec(script, (error, stream) => {
        if (error) {
            clearTimeout(timer);
            settled = true;
            reject(error);
            return;
        }
        streamRef = stream;
        stream.on('data', (data: Buffer) => appendLimited(stdoutChunks, Buffer.from(data), stdoutState));
        stream.stderr.on('data', (data: Buffer) => appendLimited(stderrChunks, Buffer.from(data), stderrState));
        stream.on('error', (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        stream.on('close', (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const truncationNote = '\n[output truncated at 1 MiB]';
            resolve({
                exitCode: typeof code === 'number' ? code : 1,
                stdout: Buffer.concat(stdoutChunks).toString('utf8') + (stdoutState.truncated ? truncationNote : ''),
                stderr: Buffer.concat(stderrChunks).toString('utf8') + (stderrState.truncated ? truncationNote : ''),
            });
        });
    });
});

const sftpCall = <T>(operation: (callback: (error: Error | null | undefined, value?: T) => void) => void): Promise<T | undefined> =>
    new Promise((resolve, reject) => operation((error, value) => error ? reject(error) : resolve(value)));

const getSftp = (client: Client): Promise<SFTPWrapper> => new Promise((resolve, reject) => {
    client.sftp((error, sftp) => error ? reject(error) : resolve(sftp));
});

const ensureRemoteDirectory = async (sftp: SFTPWrapper, remoteDirectory: string): Promise<void> => {
    const normalized = remoteDirectory.replace(/\\/g, '/');
    if (!normalized || normalized === '.' || normalized === '/') return;
    const parent = path.posix.dirname(normalized);
    if (parent && parent !== normalized) await ensureRemoteDirectory(sftp, parent);
    try {
        await sftpCall<void>(callback => sftp.mkdir(normalized, callback));
    } catch (error: any) {
        if (error?.code !== 4 && error?.code !== 'FAILURE') throw error;
    }
};

const remoteExists = async (sftp: SFTPWrapper, remoteFile: string): Promise<boolean> => {
    try {
        await sftpCall(callback => sftp.stat(remoteFile, callback));
        return true;
    } catch {
        return false;
    }
};

const uploadFiles = async (
    client: Client,
    payload: UploadPayload,
    timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const sftp = await getSftp(client);
    const uploaded: string[] = [];
    const multiFileDestination = payload.files.length > 1 || /[\\/]$/.test(payload.remotePath);

    const work = (async () => {
        for (const file of payload.files) {
            const remoteFile = multiFileDestination
                ? path.posix.join(payload.remotePath.replace(/\\/g, '/'), file.originalName)
                : payload.remotePath.replace(/\\/g, '/');
            await ensureRemoteDirectory(sftp, path.posix.dirname(remoteFile));
            if (!payload.overwrite && await remoteExists(sftp, remoteFile)) {
                throw new Error(`Remote file already exists: ${remoteFile}`);
            }
            await sftpCall<void>(callback => sftp.fastPut(file.storedPath, remoteFile, callback));
            uploaded.push(`${file.originalName} → ${remoteFile}`);
        }
        return { exitCode: 0, stdout: uploaded.join('\n'), stderr: '' };
    })();

    const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Upload timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
    });
    try {
        return await Promise.race([work, timeout]);
    } finally {
        try { sftp.end(); } catch { /* client cleanup follows */ }
    }
};

const runPlaybook = async (
    client: Client,
    job: JobRow,
    payload: PlaybookPayload,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const append = (current: string, value: string): string => {
        if (!value || Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
        const combined = `${current}${value}`;
        const bytes = Buffer.from(combined, 'utf8');
        return bytes.length <= MAX_OUTPUT_BYTES
            ? combined
            : `${bytes.subarray(0, MAX_OUTPUT_BYTES).toString('utf8')}\n[playbook output truncated at 1 MiB]`;
    };
    const runtimeVariables = jobPlaybookVariables.get(job.id) || {};
    const render = (template: string): string => template.replace(
        /\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g,
        (_match, variableName: string) => runtimeVariables[variableName] ?? '',
    );

    for (let index = 0; index < payload.steps.length; index += 1) {
        if (await isCancellationRequested(job.id)) throw new Error('Cancelled by user.');
        const step = payload.steps[index];
        const heading = `\n===== [${index + 1}/${payload.steps.length}] ${step.name} =====\n`;
        stdout = append(stdout, heading);
        const result = step.type === 'command'
            ? await execScript(client, [render(step.command)], true, job.timeout_seconds * 1000)
            : await uploadFiles(client, {
                kind: 'upload',
                files: step.files,
                remotePath: render(step.remotePath),
                overwrite: step.overwrite,
            }, job.timeout_seconds * 1000);
        stdout = append(stdout, result.stdout ? `${result.stdout}\n` : '');
        stderr = append(stderr, result.stderr ? `${heading}${result.stderr}\n` : '');
        if (result.exitCode !== 0) {
            exitCode = result.exitCode;
            if (job.stop_on_error === 1 && !step.continueOnError) break;
        }
    }
    return { exitCode, stdout, stderr };
};

const isCancellationRequested = async (jobId: string): Promise<boolean> => {
    const db = await getDbInstance();
    const row = await getDb<{ cancel_requested: number }>(db, 'SELECT cancel_requested FROM orchestration_jobs WHERE id = ?', [jobId]);
    return row?.cancel_requested === 1;
};

const runTarget = async (job: JobRow, target: TargetRow, payload: JobPayload): Promise<void> => {
    const db = await getDbInstance();
    if (await isCancellationRequested(job.id)) {
        await runDb(db, `UPDATE orchestration_job_targets SET status = 'cancelled', finished_at = ? WHERE id = ?`, [nowSeconds(), target.id]);
        return;
    }

    const startedAt = Date.now();
    const redact = (text: string): string => (jobPlaybookRedactions.get(job.id) || [])
        .reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
    await runDb(db, `UPDATE orchestration_job_targets SET status = 'running', started_at = ? WHERE id = ?`, [nowSeconds(), target.id]);
    let client: Client | null = null;
    try {
        if (target.connection_id === null) throw new Error('The target server has been deleted.');
        const details = await SshService.getConnectionDetails(target.connection_id, jobCredentials.get(job.id)?.get(target.connection_id));
        client = await SshService.establishSshConnection(details, Math.min(job.timeout_seconds * 1000, 30000));
        if (!activeClients.has(job.id)) activeClients.set(job.id, new Set());
        activeClients.get(job.id)?.add(client);

        const result = payload.kind === 'command'
            ? await execScript(client, payload.commands, job.stop_on_error === 1, job.timeout_seconds * 1000)
            : payload.kind === 'upload'
                ? await uploadFiles(client, payload, job.timeout_seconds * 1000)
                : await runPlaybook(client, job, payload);
        const success = result.exitCode === 0;
        const recordOutput = payload.kind !== 'command' || payload.recordOutput;
        await runDb(
            db,
            `UPDATE orchestration_job_targets SET
                status = ?, exit_code = ?, encrypted_stdout = ?, encrypted_stderr = ?,
                error = ?, finished_at = ?, duration_ms = ? WHERE id = ?`,
            [
                success ? 'success' : 'failed',
                result.exitCode,
                recordOutput && result.stdout ? encrypt(redact(result.stdout)) : null,
                recordOutput && result.stderr ? encrypt(redact(result.stderr)) : null,
                success ? null : `Remote process exited with code ${result.exitCode}.`,
                nowSeconds(),
                Date.now() - startedAt,
                target.id,
            ],
        );
    } catch (error: any) {
        const cancelled = await isCancellationRequested(job.id);
        await runDb(
            db,
            `UPDATE orchestration_job_targets SET status = ?, error = ?, finished_at = ?, duration_ms = ? WHERE id = ?`,
            [cancelled ? 'cancelled' : 'failed', cancelled ? 'Cancelled by user.' : redact(String(error?.message || error)).slice(0, 2000), nowSeconds(), Date.now() - startedAt, target.id],
        );
    } finally {
        if (client) {
            activeClients.get(job.id)?.delete(client);
            try { client.end(); } catch { /* already closed */ }
        }
    }
};

const updateJobStats = async (jobId: string): Promise<void> => {
    const db = await getDbInstance();
    const stats = await getDb<{ completed: number; succeeded: number; failed: number }>(
        db,
        `SELECT
            SUM(CASE WHEN status IN ('success', 'failed', 'cancelled') THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM orchestration_job_targets WHERE job_id = ?`,
        [jobId],
    );
    await runDb(
        db,
        `UPDATE orchestration_jobs SET completed_count = ?, success_count = ?, failed_count = ?, updated_at = ? WHERE id = ?`,
        [stats?.completed || 0, stats?.succeeded || 0, stats?.failed || 0, nowSeconds(), jobId],
    );
};

const cleanupUploadPayload = async (payload: JobPayload): Promise<void> => {
    const files = payload.kind === 'upload'
        ? payload.files
        : payload.kind === 'playbook'
            ? payload.steps.flatMap(step => step.type === 'upload' ? step.files : [])
            : [];
    await Promise.all(files.map(file => fs.promises.unlink(file.storedPath).catch(() => undefined)));
};

const runJob = async (jobId: string): Promise<void> => {
    if (activeJobs.has(jobId)) return;
    activeJobs.add(jobId);
    const db = await getDbInstance();
    let payload: JobPayload | null = null;
    try {
        const job = await getDb<JobRow>(db, 'SELECT * FROM orchestration_jobs WHERE id = ?', [jobId]);
        if (!job || job.status !== 'queued') return;
        payload = decryptPayload(job);
        await runDb(db, `UPDATE orchestration_jobs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?`, [nowSeconds(), nowSeconds(), jobId]);
        const targets = await allDb<TargetRow>(db, 'SELECT * FROM orchestration_job_targets WHERE job_id = ? ORDER BY id ASC', [jobId]);
        let cursor = 0;
        const worker = async (): Promise<void> => {
            while (cursor < targets.length) {
                const target = targets[cursor++];
                await runTarget(job, target, payload as JobPayload);
                await updateJobStats(jobId);
            }
        };
        await Promise.all(Array.from({ length: Math.min(job.concurrency, targets.length) }, () => worker()));
        await updateJobStats(jobId);

        const current = await getDb<JobRow>(db, 'SELECT * FROM orchestration_jobs WHERE id = ?', [jobId]);
        if (!current) return;
        let status: JobStatus;
        if (current.cancel_requested === 1) status = 'cancelled';
        else if (current.success_count === current.target_count) status = 'success';
        else if (current.success_count > 0) status = 'partial';
        else status = 'failed';
        await runDb(db, 'UPDATE orchestration_jobs SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?', [status, nowSeconds(), nowSeconds(), jobId]);
        await auditLogService.logAction('ORCHESTRATION_JOB_COMPLETED', {
            jobId,
            status,
            targetCount: current.target_count,
            successCount: current.success_count,
            failedCount: current.failed_count,
        });
    } finally {
        if (payload) await cleanupUploadPayload(payload);
        activeClients.delete(jobId);
        jobCredentials.delete(jobId);
        jobPlaybookVariables.delete(jobId);
        jobPlaybookRedactions.delete(jobId);
        activeJobs.delete(jobId);
    }
};

const publicJob = (row: JobRow): Record<string, unknown> => ({
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    targetCount: row.target_count,
    completedCount: row.completed_count,
    successCount: row.success_count,
    failedCount: row.failed_count,
    concurrency: row.concurrency,
    timeoutSeconds: row.timeout_seconds,
    stopOnError: row.stop_on_error === 1,
    summary: JSON.parse(row.payload_summary || '{}'),
    createdBy: row.created_by_name || null,
    cancelRequested: row.cancel_requested === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
});

export const listJobs = async (limit = 50): Promise<Record<string, unknown>[]> => {
    const db = await getDbInstance();
    const rows = await allDb<JobRow>(
        db,
        `SELECT j.*, u.username AS created_by_name
         FROM orchestration_jobs j LEFT JOIN users u ON u.id = j.created_by
         ORDER BY j.created_at DESC LIMIT ?`,
        [clampInteger(limit, 50, 1, 100)],
    );
    return rows.map(publicJob);
};

export const getJobDetail = async (jobId: string): Promise<Record<string, unknown> | null> => {
    const db = await getDbInstance();
    const row = await getDb<JobRow>(
        db,
        `SELECT j.*, u.username AS created_by_name
         FROM orchestration_jobs j LEFT JOIN users u ON u.id = j.created_by WHERE j.id = ?`,
        [jobId],
    );
    if (!row) return null;
    const payload = decryptPayload(row);
    const targets = await allDb<TargetRow>(db, 'SELECT * FROM orchestration_job_targets WHERE job_id = ? ORDER BY id ASC', [jobId]);
    const safePayload = payload.kind === 'command'
        ? { kind: payload.kind, commands: payload.commands, recordOutput: payload.recordOutput }
        : payload.kind === 'upload'
            ? { kind: payload.kind, files: payload.files.map(file => ({ originalName: file.originalName, size: file.size })), remotePath: payload.remotePath, overwrite: payload.overwrite }
            : {
                kind: payload.kind,
                playbookId: payload.playbookId,
                revision: payload.revision,
                steps: payload.steps.map(step => step.type === 'command'
                    ? step
                    : { ...step, files: step.files.map(file => ({ originalName: file.originalName, size: file.size })) }),
            };
    return {
        ...publicJob(row),
        payload: safePayload,
        targets: targets.map(target => ({
            id: target.id,
            connectionId: target.connection_id,
            connectionName: target.connection_name,
            host: target.host,
            status: target.status,
            exitCode: target.exit_code,
            stdout: target.encrypted_stdout ? decrypt(target.encrypted_stdout) : '',
            stderr: target.encrypted_stderr ? decrypt(target.encrypted_stderr) : '',
            error: target.error,
            startedAt: target.started_at,
            finishedAt: target.finished_at,
            durationMs: target.duration_ms,
        })),
    };
};

export const cancelJob = async (jobId: string, userId: number | null, username?: string): Promise<boolean> => {
    const db = await getDbInstance();
    const job = await getDb<JobRow>(db, 'SELECT * FROM orchestration_jobs WHERE id = ?', [jobId]);
    if (!job) return false;
    if (!['queued', 'running'].includes(job.status)) throw new Error('Only queued or running jobs can be cancelled.');
    await runDb(db, 'UPDATE orchestration_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?', [nowSeconds(), jobId]);
    await runDb(db, `UPDATE orchestration_job_targets SET status = 'cancelled', finished_at = ? WHERE job_id = ? AND status = 'queued'`, [nowSeconds(), jobId]);
    activeClients.get(jobId)?.forEach(client => {
        try { client.end(); } catch { /* already closed */ }
    });
    await auditLogService.logAction('ORCHESTRATION_JOB_CANCELLED', { jobId, userId, username });
    return true;
};

export const initializeOrchestration = async (): Promise<void> => {
    await fs.promises.mkdir(uploadStagingDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(uploadStagingDirectory, 0o700).catch(() => undefined);
    const db = await getDbInstance();
    const interrupted = await allDb<JobRow>(db, `SELECT * FROM orchestration_jobs WHERE status IN ('queued', 'running')`);
    for (const job of interrupted) {
        let payload: JobPayload | null = null;
        try { payload = decryptPayload(job); } catch { /* an invalid key is surfaced elsewhere */ }
        await runDb(
            db,
            `UPDATE orchestration_jobs SET status = 'failed', finished_at = ?, updated_at = ? WHERE id = ?`,
            [nowSeconds(), nowSeconds(), job.id],
        );
        await runDb(
            db,
            `UPDATE orchestration_job_targets SET status = 'failed', error = 'Service restarted before this target completed.', finished_at = ?
             WHERE job_id = ? AND status IN ('queued', 'running')`,
            [nowSeconds(), job.id],
        );
        await updateJobStats(job.id);
        if (payload) await cleanupUploadPayload(payload);
    }
    // No job is resumed after a process restart, so every remaining staged file
    // is orphaned and can be removed before the API starts accepting requests.
    const orphanedFiles = await fs.promises.readdir(uploadStagingDirectory, { withFileTypes: true });
    await Promise.all(orphanedFiles
        .filter(entry => entry.isFile())
        .map(entry => fs.promises.unlink(path.join(uploadStagingDirectory, entry.name)).catch(() => undefined)));
};
