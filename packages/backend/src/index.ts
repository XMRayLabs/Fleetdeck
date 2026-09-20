import dotenv from 'dotenv';
import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import session from 'express-session';
import sessionFileStore from 'session-file-store';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

const dataRoot = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.join(dataRoot, '.env'), override: false });

for (const [targetName, fileVariable] of [
    ['ENCRYPTION_KEY', 'ENCRYPTION_KEY_FILE'],
    ['SESSION_SECRET', 'SESSION_SECRET_FILE'],
    ['REMOTE_GATEWAY_SHARED_SECRET', 'REMOTE_GATEWAY_SHARED_SECRET_FILE'],
] as const) {
    const secretFile = process.env[fileVariable];
    if (!secretFile) continue;

    try {
        process.env[targetName] = fs.readFileSync(secretFile, 'utf8').trim();
    } catch (error: any) {
        throw new Error(`Unable to read ${targetName} from its secret file: ${error.message}`);
    }
}

import { getDbInstance } from './database/connection';
import authRouter from './auth/auth.routes';
import aiRouter from './ai/ai.routes';
import connectionsRouter from './connections/connections.routes';
import sftpRouter from './sftp/sftp.routes';
import proxyRoutes from './proxies/proxies.routes';
import tagsRouter from './tags/tags.routes';
import settingsRoutes from './settings/settings.routes';
import notificationRoutes from './notifications/notification.routes';
import auditRoutes from './audit/audit.routes';
import commandHistoryRoutes from './command-history/command-history.routes';
import quickCommandsRoutes from './quick-commands/quick-commands.routes';
import terminalThemeRoutes from './terminal-themes/terminal-theme.routes';
import appearanceRoutes from './appearance/appearance.routes';
import sshKeysRouter from './ssh_keys/ssh_keys.routes';
import quickCommandTagRoutes from './quick-command-tags/quick-command-tag.routes';
import sshSuspendRouter from './ssh-suspend/ssh-suspend.routes';
import { transfersRoutes } from './transfers/transfers.routes';
import pathHistoryRoutes from './path-history/path-history.routes';
import favoritePathsRouter from './favorite-paths/favorite-paths.routes';
import orchestrationRouter from './orchestration/orchestration.routes';
import { initializeOrchestration } from './orchestration/orchestration.service';
import playbookRouter from './playbooks/playbook.routes';
import { initializePlaybooks } from './playbooks/playbook.service';
import { initializeWebSocket } from './websocket';
import { ipWhitelistMiddleware } from './auth/ipWhitelist.middleware';

import './services/event.service';
import './notifications/notification.processor.service';
import './notifications/notification.dispatcher.service';

const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3001);

const ensureRuntimeSecrets = (): void => {
    const required = ['ENCRYPTION_KEY', 'SESSION_SECRET'];
    if (isProduction || process.env.REQUIRE_EXTERNAL_SECRETS === 'true') {
        if (process.env.REMOTE_GATEWAY_API_BASE_DOCKER) required.push('REMOTE_GATEWAY_SHARED_SECRET');
        const missing = required.filter((name) => !process.env[name]);
        if (missing.length > 0) {
            throw new Error(`Missing required secret(s): ${missing.join(', ')}. Run scripts/init-secrets first.`);
        }
        return;
    }

    fs.mkdirSync(dataRoot, { recursive: true });
    const generated: string[] = [];
    if (!process.env.ENCRYPTION_KEY) {
        process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
        generated.push(`ENCRYPTION_KEY=${process.env.ENCRYPTION_KEY}`);
    }
    if (!process.env.SESSION_SECRET) {
        process.env.SESSION_SECRET = crypto.randomBytes(64).toString('hex');
        generated.push(`SESSION_SECRET=${process.env.SESSION_SECRET}`);
    }
    if (generated.length > 0) {
        fs.appendFileSync(path.join(dataRoot, '.env'), `${generated.join('\n')}\n`, { mode: 0o600 });
        console.warn('[Security] Development secrets were generated in the data directory. Back them up securely.');
    }
};

const app = express();
const server = http.createServer(app);
app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '2mb', strict: true }));
app.use(ipWhitelistMiddleware as RequestHandler);

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.API_RATE_LIMIT || 1200),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: '请求过于频繁，请稍后重试。' },
});
app.use('/api/', apiLimiter);

const allowedOrigin = process.env.APP_ORIGIN || process.env.RP_ORIGIN;
app.use('/api/', (req: Request, res: Response, next: NextFunction): void => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next();

    const expectedOrigin = allowedOrigin || `${req.protocol}://${req.get('host')}`;
    try {
        if (new URL(origin).origin !== new URL(expectedOrigin).origin) {
            res.status(403).json({ message: '请求来源不受信任。' });
            return;
        }
    } catch {
        res.status(403).json({ message: '请求来源无效。' });
        return;
    }
    next();
});

const initializeDatabase = async (): Promise<void> => {
    const db = await getDbInstance();
    await new Promise<void>((resolve, reject) => {
        db.get('SELECT COUNT(*) as count FROM users', (error: Error | null) => error ? reject(error) : resolve());
    });
};

const registerRoutes = (sessionMiddleware: RequestHandler): void => {
    app.use(sessionMiddleware);
    app.use('/api/v1/auth', authRouter);
    app.use('/api/v1/connections', connectionsRouter);
    app.use('/api/v1/sftp', sftpRouter);
    app.use('/api/v1/proxies', proxyRoutes);
    app.use('/api/v1/tags', tagsRouter);
    app.use('/api/v1/settings', settingsRoutes);
    app.use('/api/v1/ai', aiRouter);
    app.use('/api/v1/notifications', notificationRoutes);
    app.use('/api/v1/audit-logs', auditRoutes);
    app.use('/api/v1/command-history', commandHistoryRoutes);
    app.use('/api/v1/quick-commands', quickCommandsRoutes);
    app.use('/api/v1/terminal-themes', terminalThemeRoutes);
    app.use('/api/v1/appearance', appearanceRoutes);
    app.use('/api/v1/ssh-keys', sshKeysRouter);
    app.use('/api/v1/quick-command-tags', quickCommandTagRoutes);
    app.use('/api/v1/ssh-suspend', sshSuspendRouter);
    app.use('/api/v1/transfers', transfersRoutes());
    app.use('/api/v1/path-history', pathHistoryRoutes);
    app.use('/api/v1/favorite-paths', favoritePathsRouter);
    app.use('/api/v1/orchestration', orchestrationRouter);
    app.use('/api/v1/playbooks', playbookRouter);
    app.get('/api/v1/status', (_req: Request, res: Response): void => {
        res.json({ status: 'ok', service: 'fleetdeck-backend' });
    });

    app.use('/api/', (_req: Request, res: Response): void => {
        res.status(404).json({ message: 'API endpoint not found.' });
    });
    app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        console.error('[HTTP] Unhandled request error:', error);
        res.status(500).json({ message: '服务器内部错误。' });
    });
};

const main = async (): Promise<void> => {
    ensureRuntimeSecrets();
    await initializeDatabase();
    await initializePlaybooks();
    await initializeOrchestration();

    const FileStore = sessionFileStore(session);
    const sessionsPath = path.join(dataRoot, 'sessions');
    fs.mkdirSync(sessionsPath, { recursive: true });
    const sessionMiddleware = session({
        name: 'fleetdeck.sid',
        store: new FileStore({ path: sessionsPath, ttl: 30 * 24 * 60 * 60, logFn: () => undefined }),
        secret: process.env.SESSION_SECRET as string,
        resave: false,
        saveUninitialized: false,
        proxy: true,
        cookie: {
            httpOnly: true,
            secure: isProduction && process.env.COOKIE_SECURE !== 'false',
            sameSite: 'strict',
            maxAge: 12 * 60 * 60 * 1000,
        },
    });

    registerRoutes(sessionMiddleware as RequestHandler);
    server.listen(port, '0.0.0.0', () => {
        console.log(`[FleetDeck] Backend listening on port ${port}.`);
        initializeWebSocket(server, sessionMiddleware as RequestHandler);
    });
};

const shutdown = (signal: string): void => {
    console.log(`[FleetDeck] ${signal} received, closing HTTP server.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
    console.error('[Fatal] Unhandled promise rejection:', reason);
    process.exit(1);
});
process.on('uncaughtException', (error) => {
    console.error('[Fatal] Uncaught exception:', error);
    process.exit(1);
});

main().catch((error) => {
    console.error('[FleetDeck] Startup failed:', error);
    process.exit(1);
});
