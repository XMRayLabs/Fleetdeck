import { Router, Request, Response } from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { isAuthenticated } from '../auth/auth.middleware';
import { getDbInstance, runDb, getDb, allDb } from '../database/connection';
import { encrypt, decrypt } from '../utils/crypto';
import { createCommandJob, getJobDetail, cancelJob } from '../orchestration/orchestration.service';
import { redact, redactValue } from './redact';
import { endpoint, askProvider } from './provider';

const router = Router();
type Config = { base: string; model: string; key: string };
type Pending = { user: number; expires: number; content: string; targets: number[]; fingerprint: string; commands?: string[]; base: string; model: string };
const pending = new Map<string, Pending>();
const busy = new Set<number>();
let initialized: Promise<unknown> | undefined;
async function db() {
    const database = await getDbInstance();
    initialized ||= runDb(database, 'CREATE TABLE IF NOT EXISTS ai_user_config (user_id INTEGER PRIMARY KEY, encrypted_config TEXT NOT NULL)')
        .then(() => runDb(database, 'CREATE TABLE IF NOT EXISTS ai_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, action TEXT NOT NULL, job_id TEXT, created_at INTEGER NOT NULL)'));
    await initialized;
    return database;
}
async function config(user: number): Promise<Config> {
    const row = await getDb(await db(), 'SELECT encrypted_config FROM ai_user_config WHERE user_id = ?', [user]);
    return row ? JSON.parse(decrypt(row.encrypted_config)) : { base: '', model: '', key: '' };
}
async function secrets(user: number): Promise<string[]> {
    const database = await db();
    const result = [(await config(user)).key, process.env.ENCRYPTION_KEY || '', process.env.SESSION_SECRET || '', process.env.REMOTE_GATEWAY_SHARED_SECRET || ''];
    for (const table of ['connections', 'proxies', 'ssh_keys']) {
        const rows = await allDb<Record<string, unknown>>(database, `SELECT * FROM ${table}`);
        for (const row of rows) for (const [column, value] of Object.entries(row)) {
            if (column.startsWith('encrypted_') && typeof value === 'string' && value) result.push(decrypt(value));
        }
    }
    return result.filter(Boolean);
}
async function event(user: number, action: string, job?: string) {
    await runDb(await db(), 'INSERT INTO ai_events (user_id,action,job_id,created_at) VALUES (?,?,?,?)', [user, action, job || null, Date.now()]);
}
async function fingerprint(targets: number[]): Promise<string> {
    const rows = [];
    for (const id of targets) {
        const row = await getDb(await db(), 'SELECT * FROM connections WHERE id=?', [id]);
        if (row?.type !== 'SSH') throw new Error('SSH target no longer exists.');
        // Ignore telemetry updates, but invalidate approvals after connection configuration changes.
        delete row.last_connected_at; delete row.updated_at;
        rows.push(row);
    }
    // A shared proxy/key change also invalidates outstanding approvals.
    for (const table of ['proxies', 'ssh_keys']) rows.push(await allDb(await db(), `SELECT * FROM ${table} ORDER BY id`));
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}
function savePending(data: Omit<Pending, 'expires'>) {
    for (const [id, entry] of pending) if (entry.expires < Date.now()) pending.delete(id);
    if (pending.size >= 200) throw new Error('待处理请求过多，请稍后再试。');
    const id = randomUUID(); pending.set(id, { ...data, expires: Date.now() + 10 * 60_000 });
    setTimeout(() => pending.delete(id), 10 * 60_000).unref();
    return id;
}
function take(id: unknown, user: number, proposal: boolean): Pending {
    const entry = typeof id === 'string' ? pending.get(id) : undefined;
    if (!entry || entry.user !== user || entry.expires < Date.now() || Boolean(entry.commands) !== proposal) throw new Error('确认已过期或无效，请重新生成。');
    pending.delete(id as string); return entry;
}
const handle = (fn: (req: Request, res: Response, user: number) => Promise<void>) => async (req: Request, res: Response) => {
    try { await fn(req, res, req.session.userId!); }
    catch (error) { res.status(400).json({ message: error instanceof Error && !/SQLITE|decrypt|加密|解密/i.test(error.message) ? error.message : 'AI 操作失败，请检查配置。' }); }
};
router.use(isAuthenticated);
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.use(rateLimit({ windowMs: 60000, limit: 30, keyGenerator: req => String(req.session.userId), standardHeaders: true, legacyHeaders: false }));
router.get('/config', handle(async (_req, res, user) => { const c = await config(user); res.json({ base: c.base, model: c.model, hasKey: Boolean(c.key) }); }));
router.put('/config', handle(async (req, res, user) => {
    const { base, model, apiKey } = req.body;
    if (typeof base !== 'string' || base.length > 2048 || typeof model !== 'string' || !model.trim() || model.length > 150 || /[\r\n]/.test(model)) throw new Error('API 地址或模型名称无效。');
    endpoint(base);
    const previous = await config(user);
    const key = typeof apiKey === 'string' && apiKey ? apiKey : previous.base === base ? previous.key : '';
    if (!key || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('请填写 API Key；更换 API 地址必须重新填写密钥。');
    await runDb(await db(), 'INSERT INTO ai_user_config VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET encrypted_config=excluded.encrypted_config', [user, encrypt(JSON.stringify({ base, model: model.trim(), key }))]);
    for (const [id, entry] of pending) if (entry.user === user) pending.delete(id);
    await event(user, 'config_saved'); res.json({ ok: true });
}));
router.delete('/config', handle(async (_req, res, user) => {
    await runDb(await db(), 'DELETE FROM ai_user_config WHERE user_id=?', [user]);
    for (const [id, entry] of pending) if (entry.user === user) pending.delete(id);
    await event(user, 'config_deleted'); res.json({ ok: true });
}));
router.post('/test', handle(async (_req, res, user) => {
    const c = await config(user); if (!c.key) throw new Error('请先保存 AI 配置。');
    if (busy.has(user)) throw new Error('已有 AI 请求进行中。');
    busy.add(user);
    try { await askProvider(c.base, c.key, c.model, 'Connection test only. Return {"analysis":"OK","commands":[]}'); await event(user, 'test'); res.json({ ok: true }); }
    finally { busy.delete(user); }
}));
router.post('/preview', handle(async (req, res, user) => {
    const { task, context, targetIds } = req.body;
    if (typeof task !== 'string' || !task.trim() || task.length > 8000 || typeof context !== 'string' || context.length > 64000 || !Array.isArray(targetIds) || targetIds.length > 50 || targetIds.some(id => !Number.isInteger(id) || id < 1)) throw new Error('任务、日志或服务器选择无效（任务 8,000 字，日志 64,000 字，最多 50 台）。');
    const targets = [...new Set<number>(targetIds)];
    for (const id of targets) { const row = await getDb(await db(), 'SELECT type FROM connections WHERE id=?', [id]); if (row?.type !== 'SSH') throw new Error('仅支持已存在的 SSH 服务器。'); }
    const c = await config(user); if (!c.key) throw new Error('请先保存 AI 配置。');
    const known = await secrets(user);
    const content = JSON.stringify({ task: redact(task, known), logs: redact(context, known), targetCount: targets.length }, null, 2);
    const previewId = savePending({ user, content, targets, fingerprint: await fingerprint(targets), base: c.base, model: c.model });
    res.json({ previewId, content, base: c.base, model: c.model });
}));
router.post('/analyze', handle(async (req, res, user) => {
    if (req.body.confirm !== true) throw new Error('请确认发送脱敏后的内容。');
    if (busy.has(user)) throw new Error('已有 AI 请求进行中。');
    const entry = take(req.body.previewId, user, false); const c = await config(user);
    if (entry.base !== c.base || entry.model !== c.model || !c.key) throw new Error('配置已更改，请重新预览。');
    busy.add(user);
    try {
        const raw = await askProvider(c.base, c.key, c.model, entry.content);
        const known = await secrets(user);
        let answer: any;
        try { answer = redactValue(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')), known); } catch { answer = { analysis: redact(raw, known), commands: [] }; }
        if (!answer || typeof answer !== 'object') answer = { analysis: redact(raw, known), commands: [] };
        const analysis = typeof answer.analysis === 'string' ? answer.analysis.slice(0, 24000) : redact(raw, known).slice(0, 24000);
        const commands: string[] = Array.isArray(answer.commands) ? answer.commands.filter((v: unknown) => typeof v === 'string' && v.trim() && v.length <= 8000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v) && !v.includes('[REDACTED')).slice(0, 8) : [];
        const proposalId = commands.length && entry.targets.length ? savePending({ ...entry, commands, content: '' }) : null;
        await event(user, 'analyzed'); res.json({ analysis, commands, proposalId, targetIds: entry.targets });
    } finally { busy.delete(user); }
}));
router.post('/execute', handle(async (req, res, user) => {
    if (req.body.confirm !== true) throw new Error('必须明确确认目标服务器及命令。');
    const entry = take(req.body.proposalId, user, true);
    if (entry.fingerprint !== await fingerprint(entry.targets)) throw new Error('服务器配置已更改，请重新分析并确认。');
    // Only server-held targets/commands are used. A model or browser cannot substitute them.
    const temporary = req.body.ephemeralCredentials || {};
    const known = [...await secrets(user), ...Object.values(temporary).flatMap((item: any) => [item?.password, item?.passphrase]).filter((v): v is string => typeof v === 'string' && Boolean(v))];
    const jobId = await createCommandJob({ name: 'AI · confirmed commands', targetIds: entry.targets, commands: entry.commands!, concurrency: 2, timeoutSeconds: 120, stopOnError: true, recordOutput: true, ephemeralCredentials: temporary, redactOutput: true, redactedValues: known }, user, req.session.username);
    await event(user, 'executed', jobId); res.status(202).json({ jobId });
}));
async function ownedJob(user: number, id: string) {
    if (!await getDb(await db(), 'SELECT id FROM ai_events WHERE user_id=? AND job_id=? AND action=?', [user, id, 'executed'])) throw new Error('未找到此用户的 AI 任务。');
}
router.get('/jobs/:id', handle(async (req, res, user) => {
    await ownedJob(user, req.params.id); const job = await getJobDetail(req.params.id, user);
    if (!job) throw new Error('AI task not found.');
    res.json({ job: redactValue(job, await secrets(user)) });
}));
router.post('/jobs/:id/cancel', handle(async (req, res, user) => { await ownedJob(user, req.params.id); await cancelJob(req.params.id, user, req.session.username); res.json({ ok: true }); }));
router.get('/events', handle(async (_req, res, user) => { res.json(await allDb(await db(), 'SELECT action,job_id,created_at FROM ai_events WHERE user_id=? ORDER BY id DESC LIMIT 30', [user])); }));
export default router;
