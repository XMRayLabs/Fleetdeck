import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import WebSocket from 'ws';
import { getDbInstance, runDb, getDb, allDb } from '../database/connection';
import { encrypt, decrypt } from '../utils/crypto';
import { publicAddress } from './provider';
import { redactValue } from './redact';

let initialization: Promise<unknown> | undefined;
async function database() {
    const db = await getDbInstance();
    initialization ||= (async () => {
        await runDb(db, 'CREATE TABLE IF NOT EXISTS ai_monitor (user_id INTEGER PRIMARY KEY, url TEXT NOT NULL)');
        await runDb(db, 'CREATE TABLE IF NOT EXISTS ai_aliases (user_id INTEGER NOT NULL, connection_id INTEGER NOT NULL, alias TEXT NOT NULL, PRIMARY KEY(user_id,alias))');
        await runDb(db, 'CREATE TABLE IF NOT EXISTS ai_monitor_bindings (user_id INTEGER NOT NULL, node_id INTEGER NOT NULL, connection_id INTEGER NOT NULL, PRIMARY KEY(user_id,node_id), UNIQUE(user_id,connection_id))');
        await runDb(db, 'CREATE TABLE IF NOT EXISTS ai_conversations (id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,title TEXT NOT NULL,encrypted_body TEXT NOT NULL,updated_at INTEGER NOT NULL)');
    })();
    await initialization; return db;
}
export function monitorUrl(raw: string): string {
    const url = new URL(raw.includes('://') ? raw : 'https://' + raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port && url.port !== '443') throw new Error('监控地址必须是公网 HTTPS 地址，不得包含凭据或查询参数。');
    return url.href.replace(/\/+$/, '');
}
export function normalizeTelemetry(value: any) {
    if (!Array.isArray(value?.servers)) throw new Error('不兼容的哪吒实时数据格式。');
    const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
    return value.servers.slice(0, 500).filter((s: any) => Number.isSafeInteger(s?.id)).map((s: any) => ({
        id: s.id, name: String(s.name || s.id).slice(0, 150), platform: String(s.host?.platform || '').slice(0, 150),
        lastActive: typeof s.last_active === 'string' ? s.last_active.slice(0, 80) : null,
        cpu: number(s.state?.cpu), memoryUsed: number(s.state?.mem_used), memoryTotal: number(s.host?.mem_total),
        diskUsed: number(s.state?.disk_used), diskTotal: number(s.host?.disk_total), load1: number(s.state?.load_1),
        load5: number(s.state?.load_5), load15: number(s.state?.load_15), netIn: number(s.state?.net_in_speed), netOut: number(s.state?.net_out_speed), uptime: number(s.state?.uptime),
    }));
}
export async function readNezha(raw: string): Promise<any[]> {
    const base = monitorUrl(raw); const url = new URL(base + '/api/v1/ws/server'); url.protocol = 'wss:';
    let dnsTimer: ReturnType<typeof setTimeout> | undefined;
    const records = await Promise.race([lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }), new Promise<never>((_, reject) => { dnsTimer = setTimeout(() => reject(new Error('监控 DNS 超时。')), 5000); })]).finally(() => clearTimeout(dnsTimer));
    if (!records.length || records.some(r => !publicAddress(r.address))) throw new Error('监控地址不得指向内网或保留地址。');
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { followRedirects: false, handshakeTimeout: 8000, maxPayload: 2 * 1024 * 1024, lookup: ((_host: any, options: any, cb: any) => options?.all ? cb(null, records) : cb(null, records[0].address, records[0].family)) as any });
        let settled = false;
        const finish = (error?: Error, data?: any[]) => { if (settled) return; settled = true; clearTimeout(timer); ws.terminate(); error ? reject(error) : resolve(data!); };
        const timer = setTimeout(() => finish(new Error('哪吒监控连接超时。')), 10000);
        ws.once('message', data => { try { finish(undefined, normalizeTelemetry(JSON.parse(data.toString()))); } catch { finish(new Error('无法读取哪吒公开状态数据。')); } });
        ws.on('error', () => finish(new Error('哪吒实时接口不可达或需要登录。')));
        ws.once('close', () => { if (!settled) finish(new Error('哪吒连接已关闭。')); });
    });
}
const snapshots = new Map<number, { fetchedAt: number; source: string; servers: any[] }>();
const reading = new Map<string, Promise<any>>();
export async function monitorSnapshot(user: number) {
    const row = await getDb(await database(), 'SELECT url FROM ai_monitor WHERE user_id=?', [user]);
    if (!row?.url) throw new Error('请先配置监控探针地址。');
    const cached = snapshots.get(user);
    if (cached && cached.source === row.url && Date.now() - cached.fetchedAt < 5000) return cached;
    const key = `${user}:${row.url}`;
    if (reading.has(key)) return reading.get(key)!;
    const task = readNezha(row.url).then(async servers => {
        const current = await getDb(await database(), 'SELECT url FROM ai_monitor WHERE user_id=?', [user]);
        if (current?.url !== row.url) throw new Error('监控配置已更改，请重试。');
        const snapshot = { source: row.url, fetchedAt: Date.now(), servers };
        if (snapshots.size >= 100) snapshots.delete(snapshots.keys().next().value!);
        snapshots.set(user, snapshot); return snapshot;
    }).finally(() => reading.delete(key));
    reading.set(key, task); return task;
}
export async function inventory(user: number) {
    const db = await database();
    const connections = await allDb<any>(db, 'SELECT id,name,host,port,type,username FROM connections ORDER BY id');
    const aliases = await allDb<any>(db, 'SELECT connection_id,alias FROM ai_aliases WHERE user_id=?', [user]);
    const bindings = await allDb<any>(db, 'SELECT node_id,connection_id FROM ai_monitor_bindings WHERE user_id=?', [user]);
    return connections.map(c => ({ ...c, aliases: aliases.filter(a => a.connection_id === c.id).map(a => a.alias), monitorNodeId: bindings.find(b => b.connection_id === c.id)?.node_id ?? null }));
}
export function matchDevices(task: string, devices: any[]) {
    const text = task.normalize('NFKC').toLowerCase();
    const groups = new Map<string, any[]>();
    for (const device of devices.filter(d => d.type === 'SSH')) for (const name of [device.name, ...device.aliases]) {
        if (typeof name !== 'string' || name.trim().length < 2) continue;
        const term = name.normalize('NFKC').trim().toLowerCase();
        let from = 0;
        while ((from = text.indexOf(term, from)) >= 0) {
            const before = text[from - 1] || ''; const after = text[from + term.length] || '';
            if (!(/[a-z0-9]/i.test(term[0]) && /[a-z0-9]/i.test(before)) && !(/[a-z0-9]/i.test(term[term.length-1]) && /[a-z0-9]/i.test(after))) { const list = groups.get(term) || []; if (!list.some(d => d.id === device.id)) list.push(device); groups.set(term, list); break; }
            from++;
        }
    }
    return { matches: [...new Map([...groups.values()].flat().map(d => [d.id, d])).values()], ambiguous: [...groups.values()].some(list => list.length > 1) };
}
export function resourceRouter(getSecrets: (user: number) => Promise<string[]>) {
    const router = Router();
    const mutations = new Map<number, Promise<void>>();
    const handle = (action: (req: any, res: any, user: number) => Promise<void>) => async (req: any, res: any) => {
        const user = req.session.userId; let release: (()=>void) | undefined;
        const previous = mutations.get(user) || Promise.resolve();
        const current = new Promise<void>(resolve=>{release=resolve;});
        if (req.method !== 'GET') { mutations.set(user,current); await previous; }
        try { await action(req, res, user); } catch { res.status(400).json({ message: '操作失败：请检查地址、权限、数据格式或别名是否重复。' }); }
        finally {release!();if(mutations.get(user)===current)mutations.delete(user);}
    };
    router.get('/inventory', handle(async (_req, res, user) => { res.json(await inventory(user)); }));
    router.post('/resolve', handle(async (req, res, user) => { if (typeof req.body.task !== 'string' || req.body.task.length > 8000) throw new Error(); res.json(matchDevices(req.body.task, await inventory(user))); }));
    router.put('/aliases/:id', handle(async (req, res, user) => {
        const id = Number(req.params.id); const aliases = req.body.aliases;
        if (!await getDb(await database(), 'SELECT id FROM connections WHERE id=?', [id]) || !Array.isArray(aliases) || aliases.length > 20 || aliases.some(a => typeof a !== 'string' || a.trim().length < 2 || a.length > 64 || /[\x00-\x1f]/.test(a))) throw new Error();
        const normalized = [...new Set<string>(aliases.map(a => a.normalize('NFKC').trim().toLowerCase()))];
        const db = await database();
        for (const alias of normalized) { const existing = await getDb(db, 'SELECT connection_id FROM ai_aliases WHERE user_id=? AND alias=?', [user, alias]); if (existing && existing.connection_id !== id) throw new Error(); }
        await runDb(db, 'DELETE FROM ai_aliases WHERE user_id=? AND connection_id=?', [user, id]);
        for (const alias of normalized) await runDb(db, 'INSERT INTO ai_aliases VALUES (?,?,?)', [user, id, alias]);
        res.json({ ok: true });
    }));
    router.get('/monitor', handle(async (_req, res, user) => { res.json(await getDb(await database(), 'SELECT url FROM ai_monitor WHERE user_id=?', [user]) || { url: '' }); }));
    router.put('/monitor', handle(async (req, res, user) => {
        if (typeof req.body.url !== 'string' || req.body.url.length > 2048) throw new Error();
        const url = monitorUrl(req.body.url); const db = await database();
        const previous = await getDb(db, 'SELECT url FROM ai_monitor WHERE user_id=?', [user]);
        if (previous?.url !== url) await runDb(db, 'DELETE FROM ai_monitor_bindings WHERE user_id=?', [user]);
        await runDb(db, 'INSERT INTO ai_monitor VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET url=excluded.url', [user, url]); snapshots.delete(user); res.json({ ok: true });
    }));
    router.get('/monitor/snapshot', handle(async (_req, res, user) => { res.json(await monitorSnapshot(user)); }));
    router.put('/monitor/bindings/:id', handle(async (req, res, user) => {
        const node = Number(req.params.id); const connection = req.body.connectionId; const db = await database();
        if (!Number.isSafeInteger(node) || connection !== null && !await getDb(db, 'SELECT id FROM connections WHERE id=?', [connection])) throw new Error();
        if (connection !== null && !(await monitorSnapshot(user)).servers.some((s: any) => s.id === node)) throw new Error();
        if (connection === null) await runDb(db, 'DELETE FROM ai_monitor_bindings WHERE user_id=? AND node_id=?', [user, node]);
        else await runDb(db, 'INSERT INTO ai_monitor_bindings VALUES (?,?,?) ON CONFLICT(user_id,node_id) DO UPDATE SET connection_id=excluded.connection_id', [user, node, connection]);
        res.json({ ok: true });
    }));
    router.get('/conversations', handle(async (_req, res, user) => {const known=await getSecrets(user);const rows=await allDb<any>(await database(), 'SELECT id,encrypted_body,updated_at FROM ai_conversations WHERE user_id=? ORDER BY updated_at DESC LIMIT 100', [user]);res.json(rows.map(row=>({id:row.id,updated_at:row.updated_at,title:redactValue(JSON.parse(decrypt(row.encrypted_body)).title,known)})));}));
    router.post('/conversations', handle(async (req, res, user) => {
        const { title, turns, targetIds } = req.body;
        if (typeof title !== 'string' || title.length > 150 || !Array.isArray(turns) || turns.length > 50 || JSON.stringify(turns).length > 200000 || !Array.isArray(targetIds) || targetIds.length > 50 || targetIds.some(id => !Number.isInteger(id))) throw new Error();
        const safe = redactValue({ turns: turns.map(v => ({ task: String(v.task || '').slice(0, 8000), analysis: String(v.analysis || '').slice(0, 24000), commands: Array.isArray(v.commands) ? v.commands.slice(0, 8).map(String) : [], model: String(v.model || ''), result: typeof v.result === 'string' ? v.result.slice(0, 32000) : '' })), targetIds }, await getSecrets(user));
        const id = randomUUID(); const db = await database();
        const count = await getDb(db, 'SELECT COUNT(*) AS total FROM ai_conversations WHERE user_id=?', [user]); if (count.total >= 100) throw new Error();
        await runDb(db, 'INSERT INTO ai_conversations VALUES (?,?,?,?,?)', [id, user, 'Conversation', encrypt(JSON.stringify({ ...safe, title: redactValue(title, await getSecrets(user)) })), Date.now()]);
        res.json({ id });
    }));
    router.get('/conversations/:id', handle(async (req, res, user) => { const row = await getDb(await database(), 'SELECT encrypted_body FROM ai_conversations WHERE id=? AND user_id=?', [req.params.id, user]); if (!row) throw new Error(); res.json(redactValue(JSON.parse(decrypt(row.encrypted_body)), await getSecrets(user))); }));
    router.delete('/conversations/:id', handle(async (req, res, user) => { await runDb(await database(), 'DELETE FROM ai_conversations WHERE id=? AND user_id=?', [req.params.id, user]); res.json({ ok: true }); }));
    return router;
}
