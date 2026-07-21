import fs from 'fs';
import path from 'path';
import nodeCrypto from 'crypto';
import { pipeline } from 'stream/promises';
import { v4 as uuidv4 } from 'uuid';
import { allDb, getDb, getDbInstance, runDb } from '../database/connection';
import { AuditLogService } from '../audit/audit.service';
import { decrypt, encrypt, getEncryptionKeyBuffer } from '../utils/crypto';
import {
    createPlaybookJob,
    PlaybookExecutionStep,
    UploadFileInput,
} from '../orchestration/orchestration.service';
import * as SshService from '../services/ssh.service';

export interface PlaybookVariableDefinition {
    name: string;
    label: string;
    defaultValue: string;
    required: boolean;
    secret: boolean;
}

export interface PlaybookCommandStep {
    id: string;
    name: string;
    type: 'command';
    command: string;
    continueOnError: boolean;
}

export interface PlaybookUploadStep {
    id: string;
    name: string;
    type: 'upload';
    fileId: string;
    remotePath: string;
    overwrite: boolean;
    continueOnError: boolean;
}

export type PlaybookStep = PlaybookCommandStep | PlaybookUploadStep;

export interface PlaybookDefinition {
    variables: PlaybookVariableDefinition[];
    steps: PlaybookStep[];
}

interface PlaybookRow {
    id: string;
    name: string;
    description: string;
    category: string;
    revision: number;
    encrypted_definition: string;
    created_by: number | null;
    created_by_name?: string | null;
    created_at: number;
    updated_at: number;
}

interface PlaybookFileRow {
    id: string;
    playbook_id: string;
    original_name: string;
    stored_name: string;
    size: number;
    created_at: number;
}

export interface PlaybookInput {
    name?: unknown;
    description?: unknown;
    category?: unknown;
    definition?: unknown;
}

export interface PlaybookRunInput {
    targetIds?: unknown;
    variableValues?: unknown;
    concurrency?: unknown;
    timeoutSeconds?: unknown;
    stopOnError?: unknown;
    ephemeralCredentials?: Record<string, SshService.EphemeralCredentials>;
}

const auditLogService = new AuditLogService();
const DATA_ROOT = process.env.DATA_DIR || path.resolve(__dirname, '..', '..', 'data');
export const playbookFilesDirectory = path.join(DATA_ROOT, 'playbook-files');
export const playbookUploadIngressDirectory = path.join(DATA_ROOT, 'playbook-inbox');
const playbookRunStagingDirectory = path.join(DATA_ROOT, 'job-uploads');
const VARIABLE_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,39}$/;
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g;
const ATTACHMENT_MAGIC = Buffer.from('NXPB1', 'ascii');
const ATTACHMENT_IV_LENGTH = 16;
const ATTACHMENT_TAG_LENGTH = 16;

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const requireObject = (value: unknown, message: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
    return value as Record<string, unknown>;
};

const normalizeText = (value: unknown, maxLength: number): string => String(value ?? '').trim().slice(0, maxLength);

const normalizeDefinition = (raw: unknown): PlaybookDefinition => {
    const source = requireObject(raw, 'definition must be an object.');
    const rawVariables = Array.isArray(source.variables) ? source.variables : [];
    const rawSteps = Array.isArray(source.steps) ? source.steps : [];
    if (rawVariables.length > 50) throw new Error('A playbook can define at most 50 variables.');
    if (rawSteps.length > 100) throw new Error('A playbook can contain at most 100 steps.');

    const variableNames = new Set<string>();
    const variables = rawVariables.map((rawVariable, index): PlaybookVariableDefinition => {
        const variable = requireObject(rawVariable, `Variable ${index + 1} is invalid.`);
        const name = String(variable.name ?? '').trim();
        if (!VARIABLE_NAME_PATTERN.test(name)) {
            throw new Error(`Variable ${index + 1} must use uppercase letters, numbers, and underscores, and cannot start with a number.`);
        }
        if (variableNames.has(name)) throw new Error(`Variable ${name} is duplicated.`);
        variableNames.add(name);
        const secret = variable.secret === true;
        const defaultValue = secret ? '' : String(variable.defaultValue ?? '').slice(0, 8192);
        return {
            name,
            label: normalizeText(variable.label, 80) || name,
            defaultValue,
            required: variable.required === true,
            secret,
        };
    });

    const steps = rawSteps.map((rawStep, index): PlaybookStep => {
        const step = requireObject(rawStep, `Step ${index + 1} is invalid.`);
        const type = String(step.type || 'command');
        const id = normalizeText(step.id, 80) || uuidv4();
        const name = normalizeText(step.name, 120) || `Step ${index + 1}`;
        const continueOnError = step.continueOnError === true;
        if (type === 'command') {
            const command = String(step.command ?? '').trim();
            if (!command) throw new Error(`Command step “${name}” cannot be empty.`);
            if (command.length > 32000) throw new Error(`Command step “${name}” exceeds 32,000 characters.`);
            return { id, name, type: 'command', command, continueOnError };
        }
        if (type === 'upload') {
            const fileId = normalizeText(step.fileId, 80);
            const remotePath = normalizeText(step.remotePath, 2048);
            if (!fileId) throw new Error(`Upload step “${name}” must select an attachment.`);
            if (!remotePath) throw new Error(`Upload step “${name}” must provide a remote path.`);
            return {
                id,
                name,
                type: 'upload',
                fileId,
                remotePath,
                overwrite: step.overwrite !== false,
                continueOnError,
            };
        }
        throw new Error(`Step ${index + 1} has an unsupported type.`);
    });

    for (const step of steps) {
        const templates = step.type === 'command' ? [step.command] : [step.remotePath];
        for (const template of templates) {
            const placeholderPattern = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
            let match: RegExpExecArray | null;
            while ((match = placeholderPattern.exec(template)) !== null) {
                if (!variableNames.has(match[1])) throw new Error(`Step “${step.name}” references undefined variable ${match[1]}.`);
            }
        }
    }
    return { variables, steps };
};

const decryptDefinition = (row: PlaybookRow): PlaybookDefinition => {
    try {
        return normalizeDefinition(JSON.parse(decrypt(row.encrypted_definition)));
    } catch (error: any) {
        throw new Error(`Unable to decrypt playbook “${row.name}”: ${error?.message || 'invalid definition'}`);
    }
};

const getFilePath = (storedName: string): string => {
    if (!storedName || path.basename(storedName) !== storedName) throw new Error('Invalid stored attachment name.');
    return path.join(playbookFilesDirectory, storedName);
};

const encryptAttachment = async (sourcePath: string, destinationPath: string): Promise<void> => {
    const iv = nodeCrypto.randomBytes(ATTACHMENT_IV_LENGTH);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', getEncryptionKeyBuffer(), iv);
    await fs.promises.writeFile(destinationPath, Buffer.concat([ATTACHMENT_MAGIC, iv]), { mode: 0o600 });
    try {
        await pipeline(
            fs.createReadStream(sourcePath),
            cipher,
            fs.createWriteStream(destinationPath, { flags: 'a', mode: 0o600 }),
        );
        await fs.promises.appendFile(destinationPath, cipher.getAuthTag());
        await fs.promises.chmod(destinationPath, 0o600).catch(() => undefined);
    } catch (error) {
        await fs.promises.unlink(destinationPath).catch(() => undefined);
        throw error;
    }
};

const decryptAttachment = async (sourcePath: string, destinationPath: string): Promise<void> => {
    const stats = await fs.promises.stat(sourcePath);
    const headerLength = ATTACHMENT_MAGIC.length + ATTACHMENT_IV_LENGTH;
    if (stats.size < headerLength + ATTACHMENT_TAG_LENGTH) throw new Error('Encrypted playbook attachment is truncated.');
    const handle = await fs.promises.open(sourcePath, 'r');
    let header: Buffer;
    let tag: Buffer;
    try {
        header = Buffer.alloc(headerLength);
        tag = Buffer.alloc(ATTACHMENT_TAG_LENGTH);
        await handle.read(header, 0, headerLength, 0);
        await handle.read(tag, 0, ATTACHMENT_TAG_LENGTH, stats.size - ATTACHMENT_TAG_LENGTH);
    } finally {
        await handle.close();
    }
    if (!header.subarray(0, ATTACHMENT_MAGIC.length).equals(ATTACHMENT_MAGIC)) {
        throw new Error('Playbook attachment has an invalid encryption header.');
    }
    const iv = header.subarray(ATTACHMENT_MAGIC.length);
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', getEncryptionKeyBuffer(), iv);
    decipher.setAuthTag(tag);
    const encryptedLength = stats.size - headerLength - ATTACHMENT_TAG_LENGTH;
    try {
        if (encryptedLength === 0) {
            decipher.final();
            await fs.promises.writeFile(destinationPath, Buffer.alloc(0), { mode: 0o600 });
        } else {
            await pipeline(
                fs.createReadStream(sourcePath, { start: headerLength, end: stats.size - ATTACHMENT_TAG_LENGTH - 1 }),
                decipher,
                fs.createWriteStream(destinationPath, { mode: 0o600 }),
            );
        }
        await fs.promises.chmod(destinationPath, 0o600).catch(() => undefined);
    } catch (error) {
        await fs.promises.unlink(destinationPath).catch(() => undefined);
        throw error;
    }
};

const publicFile = (row: PlaybookFileRow): Record<string, unknown> => ({
    id: row.id,
    name: row.original_name,
    size: row.size,
    createdAt: row.created_at,
});

const publicPlaybook = (row: PlaybookRow, files: PlaybookFileRow[]): Record<string, unknown> => ({
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    revision: row.revision,
    definition: decryptDefinition(row),
    files: files.map(publicFile),
    createdBy: row.created_by_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

const getPlaybookRow = async (id: string): Promise<PlaybookRow | undefined> => {
    const db = await getDbInstance();
    return getDb<PlaybookRow>(
        db,
        `SELECT p.*, u.username AS created_by_name
         FROM orchestration_playbooks p
         LEFT JOIN users u ON u.id = p.created_by
         WHERE p.id = ?`,
        [id],
    );
};

const validateReferencedFiles = async (playbookId: string, definition: PlaybookDefinition): Promise<void> => {
    const fileIds = [...new Set(definition.steps.filter((step): step is PlaybookUploadStep => step.type === 'upload').map(step => step.fileId))];
    if (fileIds.length === 0) return;
    const db = await getDbInstance();
    const placeholders = fileIds.map(() => '?').join(',');
    const rows = await allDb<{ id: string }>(
        db,
        `SELECT id FROM orchestration_playbook_files WHERE playbook_id = ? AND id IN (${placeholders})`,
        [playbookId, ...fileIds],
    );
    if (rows.length !== fileIds.length) throw new Error('One or more selected attachments do not belong to this playbook.');
};

export const initializePlaybooks = async (): Promise<void> => {
    await fs.promises.mkdir(playbookFilesDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(playbookUploadIngressDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(playbookRunStagingDirectory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(playbookFilesDirectory, 0o700).catch(() => undefined);
    await fs.promises.chmod(playbookUploadIngressDirectory, 0o700).catch(() => undefined);
    await fs.promises.chmod(playbookRunStagingDirectory, 0o700).catch(() => undefined);
    // Multer writes plaintext only to this private ingress directory. Anything
    // left here means the previous process stopped before encryption completed.
    const orphanedIngressFiles = await fs.promises.readdir(playbookUploadIngressDirectory, { withFileTypes: true });
    await Promise.all(orphanedIngressFiles
        .filter(entry => entry.isFile())
        .map(entry => fs.promises.unlink(path.join(playbookUploadIngressDirectory, entry.name)).catch(() => undefined)));
};

export const listPlaybooks = async (): Promise<Record<string, unknown>[]> => {
    const db = await getDbInstance();
    const [rows, files] = await Promise.all([
        allDb<PlaybookRow>(
            db,
            `SELECT p.*, u.username AS created_by_name
             FROM orchestration_playbooks p
             LEFT JOIN users u ON u.id = p.created_by
             ORDER BY p.updated_at DESC`,
        ),
        allDb<PlaybookFileRow>(db, 'SELECT * FROM orchestration_playbook_files ORDER BY created_at ASC'),
    ]);
    const filesByPlaybook = new Map<string, PlaybookFileRow[]>();
    for (const file of files) filesByPlaybook.set(file.playbook_id, [...(filesByPlaybook.get(file.playbook_id) || []), file]);
    return rows.map(row => publicPlaybook(row, filesByPlaybook.get(row.id) || []));
};

export const getPlaybook = async (id: string): Promise<Record<string, unknown> | null> => {
    const row = await getPlaybookRow(id);
    if (!row) return null;
    const db = await getDbInstance();
    const files = await allDb<PlaybookFileRow>(db, 'SELECT * FROM orchestration_playbook_files WHERE playbook_id = ? ORDER BY created_at ASC', [id]);
    return publicPlaybook(row, files);
};

export const createPlaybook = async (
    input: PlaybookInput,
    userId: number | null,
    username?: string,
): Promise<Record<string, unknown>> => {
    const name = normalizeText(input.name, 120);
    if (!name) throw new Error('Playbook name is required.');
    const description = normalizeText(input.description, 2000);
    const category = normalizeText(input.category, 80) || 'General';
    const definition = normalizeDefinition(input.definition);
    const id = uuidv4();
    await validateReferencedFiles(id, definition);
    const timestamp = nowSeconds();
    const db = await getDbInstance();
    await runDb(
        db,
        `INSERT INTO orchestration_playbooks
         (id, name, description, category, revision, encrypted_definition, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [id, name, description, category, encrypt(JSON.stringify(definition)), userId, timestamp, timestamp],
    );
    await auditLogService.logAction('ORCHESTRATION_PLAYBOOK_CREATED', {
        playbookId: id,
        playbookName: name,
        stepCount: definition.steps.length,
        variableCount: definition.variables.length,
        userId,
        username,
    });
    return (await getPlaybook(id)) as Record<string, unknown>;
};

export const updatePlaybook = async (
    id: string,
    input: PlaybookInput,
    userId: number | null,
    username?: string,
): Promise<Record<string, unknown> | null> => {
    const existing = await getPlaybookRow(id);
    if (!existing) return null;
    const name = normalizeText(input.name, 120);
    if (!name) throw new Error('Playbook name is required.');
    const description = normalizeText(input.description, 2000);
    const category = normalizeText(input.category, 80) || 'General';
    const definition = normalizeDefinition(input.definition);
    await validateReferencedFiles(id, definition);
    const db = await getDbInstance();
    const revision = existing.revision + 1;
    await runDb(
        db,
        `UPDATE orchestration_playbooks
         SET name = ?, description = ?, category = ?, revision = ?, encrypted_definition = ?, updated_at = ?
         WHERE id = ?`,
        [name, description, category, revision, encrypt(JSON.stringify(definition)), nowSeconds(), id],
    );
    await auditLogService.logAction('ORCHESTRATION_PLAYBOOK_UPDATED', {
        playbookId: id,
        playbookName: name,
        revision,
        stepCount: definition.steps.length,
        variableCount: definition.variables.length,
        userId,
        username,
    });
    return getPlaybook(id);
};

export const addPlaybookFiles = async (
    playbookId: string,
    files: Express.Multer.File[],
): Promise<Record<string, unknown> | null> => {
    const existing = await getPlaybookRow(playbookId);
    if (!existing) {
        await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => undefined)));
        return null;
    }
    const db = await getDbInstance();
    const countRow = await getDb<{ count: number }>(
        db,
        'SELECT COUNT(*) AS count FROM orchestration_playbook_files WHERE playbook_id = ?',
        [playbookId],
    );
    if ((countRow?.count || 0) + files.length > 100) {
        await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => undefined)));
        throw new Error('A playbook can store at most 100 attachments.');
    }
    const timestamp = nowSeconds();
    const encryptedPaths: string[] = [];
    const insertedIds: string[] = [];
    try {
        for (const file of files) {
            const encryptedPath = getFilePath(file.filename);
            await encryptAttachment(file.path, encryptedPath);
            await fs.promises.unlink(file.path);
            encryptedPaths.push(encryptedPath);
            const fileId = uuidv4();
            await runDb(
                db,
                `INSERT INTO orchestration_playbook_files
                 (id, playbook_id, original_name, stored_name, size, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [fileId, playbookId, file.originalname, file.filename, file.size, timestamp],
            );
            insertedIds.push(fileId);
        }
    } catch (error) {
        await Promise.all(insertedIds.map(fileId => runDb(db, 'DELETE FROM orchestration_playbook_files WHERE id = ?', [fileId]).catch(() => undefined)));
        await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => undefined)));
        await Promise.all(encryptedPaths.map(filePath => fs.promises.unlink(filePath).catch(() => undefined)));
        throw error;
    }
    return getPlaybook(playbookId);
};

export const deletePlaybookFile = async (playbookId: string, fileId: string): Promise<boolean> => {
    const row = await getPlaybookRow(playbookId);
    if (!row) return false;
    const definition = decryptDefinition(row);
    if (definition.steps.some(step => step.type === 'upload' && step.fileId === fileId)) {
        throw new Error('This attachment is used by an upload step. Remove that step or select another attachment first.');
    }
    const db = await getDbInstance();
    const file = await getDb<PlaybookFileRow>(
        db,
        'SELECT * FROM orchestration_playbook_files WHERE id = ? AND playbook_id = ?',
        [fileId, playbookId],
    );
    if (!file) return false;
    await runDb(db, 'DELETE FROM orchestration_playbook_files WHERE id = ?', [fileId]);
    await fs.promises.unlink(getFilePath(file.stored_name)).catch(() => undefined);
    return true;
};

export const deletePlaybook = async (
    id: string,
    userId: number | null,
    username?: string,
): Promise<boolean> => {
    const row = await getPlaybookRow(id);
    if (!row) return false;
    const db = await getDbInstance();
    const files = await allDb<PlaybookFileRow>(db, 'SELECT * FROM orchestration_playbook_files WHERE playbook_id = ?', [id]);
    await runDb(db, 'DELETE FROM orchestration_playbooks WHERE id = ?', [id]);
    await Promise.all(files.map(file => fs.promises.unlink(getFilePath(file.stored_name)).catch(() => undefined)));
    await auditLogService.logAction('ORCHESTRATION_PLAYBOOK_DELETED', {
        playbookId: id,
        playbookName: row.name,
        revision: row.revision,
        userId,
        username,
    });
    return true;
};

export const executePlaybook = async (
    id: string,
    input: PlaybookRunInput,
    userId: number | null,
    username?: string,
): Promise<string | null> => {
    const row = await getPlaybookRow(id);
    if (!row) return null;
    const definition = decryptDefinition(row);
    if (definition.steps.length === 0) throw new Error('This playbook has no executable steps.');

    const valuesSource = input.variableValues === undefined
        ? {}
        : requireObject(input.variableValues, 'variableValues must be an object.');
    const runtimeVariables: Record<string, string> = {};
    for (const variable of definition.variables) {
        const supplied = Object.prototype.hasOwnProperty.call(valuesSource, variable.name);
        const value = String(supplied ? valuesSource[variable.name] ?? '' : variable.defaultValue);
        if (value.length > 16384) throw new Error(`Variable ${variable.name} exceeds 16,384 characters.`);
        if (variable.required && !value) throw new Error(`Variable ${variable.label || variable.name} is required.`);
        runtimeVariables[variable.name] = value;
    }

    const db = await getDbInstance();
    const fileRows = await allDb<PlaybookFileRow>(db, 'SELECT * FROM orchestration_playbook_files WHERE playbook_id = ?', [id]);
    const filesById = new Map(fileRows.map(file => [file.id, file]));
    const stagedByFileId = new Map<string, UploadFileInput>();
    const stagedPaths: string[] = [];

    try {
        const executionSteps: PlaybookExecutionStep[] = [];
        for (const step of definition.steps) {
            if (step.type === 'command') {
                executionSteps.push({ ...step });
                continue;
            }
            const file = filesById.get(step.fileId);
            if (!file) throw new Error(`Attachment for upload step “${step.name}” no longer exists.`);
            let stagedFile = stagedByFileId.get(file.id);
            if (!stagedFile) {
                const extension = path.extname(file.stored_name).slice(0, 32);
                const storedPath = path.join(playbookRunStagingDirectory, `${uuidv4()}${extension}`);
                await decryptAttachment(getFilePath(file.stored_name), storedPath);
                stagedPaths.push(storedPath);
                stagedFile = { originalName: file.original_name, storedPath, size: file.size };
                stagedByFileId.set(file.id, stagedFile);
            }
            executionSteps.push({
                id: step.id,
                name: step.name,
                type: 'upload',
                files: [stagedFile],
                remotePath: step.remotePath,
                overwrite: step.overwrite,
                continueOnError: step.continueOnError,
            });
        }

        const jobId = await createPlaybookJob({
            playbookId: id,
            playbookName: row.name,
            revision: row.revision,
            targetIds: Array.isArray(input.targetIds) ? input.targetIds.map(Number) : [],
            steps: executionSteps,
            concurrency: Number(input.concurrency),
            timeoutSeconds: Number(input.timeoutSeconds),
            stopOnError: input.stopOnError !== false,
            ephemeralCredentials: input.ephemeralCredentials,
            runtimeVariables,
            redactedValues: definition.variables
                .filter(variable => variable.secret)
                .map(variable => runtimeVariables[variable.name])
                .filter(Boolean),
        }, userId, username);
        await auditLogService.logAction('ORCHESTRATION_PLAYBOOK_EXECUTED', {
            playbookId: id,
            playbookName: row.name,
            revision: row.revision,
            jobId,
            targetCount: Array.isArray(input.targetIds) ? input.targetIds.length : 0,
            userId,
            username,
        });
        return jobId;
    } catch (error) {
        await Promise.all(stagedPaths.map(stagedPath => fs.promises.unlink(stagedPath).catch(() => undefined)));
        throw error;
    }
};
