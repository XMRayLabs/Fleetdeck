// @ts-ignore guacamole-lite does not publish TypeScript declarations
import GuacamoleLite from 'guacamole-lite';
import express, { NextFunction, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';

const wsPort = Number(process.env.REMOTE_GATEWAY_WS_PORT || 8080);
const apiPort = Number(process.env.REMOTE_GATEWAY_API_PORT || 9090);
const guacdHost = process.env.GUACD_HOST || 'guacd';
const guacdPort = Number(process.env.GUACD_PORT || 4822);

const readSharedSecret = (): string => {
    if (process.env.REMOTE_GATEWAY_SHARED_SECRET_FILE) {
        return fs.readFileSync(process.env.REMOTE_GATEWAY_SHARED_SECRET_FILE, 'utf8').trim();
    }
    return process.env.REMOTE_GATEWAY_SHARED_SECRET || '';
};

const sharedSecret = readSharedSecret();
if (process.env.NODE_ENV === 'production' && sharedSecret.length < 32) {
    throw new Error('REMOTE_GATEWAY_SHARED_SECRET must be provided in production.');
}

// guacamole-lite requires this token format. The key exists only in this process
// and rotates whenever the private gateway container restarts.
const tokenKey = crypto.randomBytes(32);
const guacServer = new GuacamoleLite(
    { port: wsPort, host: '0.0.0.0' },
    { host: guacdHost, port: guacdPort },
    { crypt: { key: tokenKey, cypher: 'aes-256-cbc' }, connectionDefaultSettings: {} },
);

if (guacServer.on) {
    guacServer.on('error', (error: Error) => console.error('[FleetDeck Gateway] WebSocket error:', error));
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '64kb', strict: true }));
app.use(rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
}));

const internalAuthentication = (req: Request, res: Response, next: NextFunction): void => {
    if (!sharedSecret) return next();
    const supplied = req.get('x-fleetdeck-gateway-key') || '';
    const expectedBuffer = Buffer.from(sharedSecret);
    const suppliedBuffer = Buffer.from(supplied);
    if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
        res.status(401).json({ error: 'Unauthorized service request.' });
        return;
    }
    next();
};

const boundedInteger = (value: unknown, fallback: number, min: number, max: number): number | null => {
    const parsed = value === undefined ? fallback : Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
};

const safeString = (value: unknown, maxLength: number): string | null => {
    if (typeof value !== 'string' || value.length > maxLength || value.includes('\0')) return null;
    return value;
};

const validHostname = (value: unknown): value is string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 253 || /[\s/\\]/.test(value)) return false;
    return net.isIP(value) !== 0 || /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.(?!-)[a-z0-9-]+)*$/i.test(value);
};

const encryptToken = (data: string): string => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', tokenKey, iv);
    const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    return Buffer.from(JSON.stringify({
        iv: iv.toString('base64'),
        value: encrypted.toString('base64'),
    })).toString('base64');
};

app.get('/healthz', (_req: Request, res: Response): void => {
    res.json({ status: 'ok' });
});

app.post('/api/remote-desktop/token', internalAuthentication, (req: Request, res: Response): void => {
    const { protocol, connectionConfig } = req.body || {};
    if (!['rdp', 'vnc'].includes(protocol) || !connectionConfig || !validHostname(connectionConfig.hostname)) {
        res.status(400).json({ error: 'Invalid protocol or hostname.' });
        return;
    }

    const port = boundedInteger(connectionConfig.port, protocol === 'rdp' ? 3389 : 5900, 1, 65535);
    const width = boundedInteger(connectionConfig.width, 1280, 320, 7680);
    const height = boundedInteger(connectionConfig.height, 720, 200, 4320);
    const username = safeString(connectionConfig.username ?? '', 256);
    const password = safeString(connectionConfig.password ?? '', 4096);
    if (!port || !width || !height || username === null || password === null) {
        res.status(400).json({ error: 'Invalid connection parameters.' });
        return;
    }

    const settings: Record<string, string> = {
        hostname: connectionConfig.hostname,
        port: String(port),
        width: String(width),
        height: String(height),
        password,
    };
    if (username) settings.username = username;

    if (protocol === 'rdp') {
        const security = ['any', 'nla', 'tls', 'rdp'].includes(connectionConfig.security)
            ? connectionConfig.security
            : 'any';
        settings.security = security;
        settings['resize-method'] = 'display-update';
        settings['ignore-cert'] = connectionConfig.ignoreCert === false || connectionConfig.ignoreCert === 'false'
            ? 'false'
            : 'true';
        settings.dpi = String(boundedInteger(connectionConfig.dpi, 96, 48, 384) || 96);
    }

    const tokenData = JSON.stringify({ connection: { type: protocol, settings } });
    res.json({ token: encryptToken(tokenData) });
});

app.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: 'Not found.' });
});
const apiServer = http.createServer(app);
apiServer.listen(apiPort, '0.0.0.0', () => {
    console.log(`[FleetDeck Gateway] API :${apiPort}, WebSocket :${wsPort}, guacd ${guacdHost}:${guacdPort}.`);
});

const gracefulShutdown = (signal: string): void => {
    console.log(`[FleetDeck Gateway] ${signal} received.`);
    apiServer.close(() => process.exit(0));
    if (guacServer && typeof guacServer.close === 'function') guacServer.close(() => undefined);
    setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
    console.error('[FleetDeck Gateway] Fatal error:', error);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FleetDeck Gateway] Unhandled rejection:', reason);
    process.exit(1);
});
