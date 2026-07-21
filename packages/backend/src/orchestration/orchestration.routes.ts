import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import sanitizeFilename from 'sanitize-filename';
import { v4 as uuidv4 } from 'uuid';
import { isAuthenticated } from '../auth/auth.middleware';
import {
    cancelJob,
    createCommandJob,
    createUploadJob,
    getJobDetail,
    listJobs,
    uploadStagingDirectory,
} from './orchestration.service';

const router = Router();
fs.mkdirSync(uploadStagingDirectory, { recursive: true, mode: 0o700 });
try { fs.chmodSync(uploadStagingDirectory, 0o700); } catch { /* Windows does not enforce POSIX modes. */ }

const maxUploadBytes = Math.max(1, Number(process.env.BATCH_UPLOAD_MAX_MB || 200)) * 1024 * 1024;
const upload = multer({
    storage: multer.diskStorage({
        destination: uploadStagingDirectory,
        filename: (_request, file, callback) => {
            const extension = path.extname(sanitizeFilename(file.originalname)).slice(0, 32);
            callback(null, `${uuidv4()}${extension}`);
        },
    }),
    limits: { fileSize: maxUploadBytes, files: 20 },
});

router.use(isAuthenticated);

router.get('/jobs', async (request: Request, response: Response) => {
    try {
        response.json({ jobs: await listJobs(Number(request.query.limit || 50)) });
    } catch (error: any) {
        response.status(500).json({ message: error?.message || 'Failed to list jobs.' });
    }
});

router.get('/jobs/:id', async (request: Request, response: Response) => {
    try {
        const job = await getJobDetail(request.params.id);
        if (!job) {
            response.status(404).json({ message: 'Job not found.' });
            return;
        }
        response.json({ job });
    } catch (error: any) {
        response.status(500).json({ message: error?.message || 'Failed to load the job.' });
    }
});

router.post('/jobs/command', async (request: Request, response: Response) => {
    try {
        const jobId = await createCommandJob(
            request.body,
            request.session.userId || null,
            request.session.username,
        );
        response.status(202).json({ jobId });
    } catch (error: any) {
        response.status(400).json({ message: error?.message || 'Invalid command job.' });
    }
});

router.post('/jobs/upload', upload.array('files', 20), async (request: Request, response: Response) => {
    const files = (request.files as Express.Multer.File[] | undefined) || [];
    try {
        // Multer has completed each file before this handler runs. Tighten the
        // mode before the paths are handed to the asynchronous job runner.
        await Promise.all(files.map(file => fs.promises.chmod(file.path, 0o600).catch(() => undefined)));
        let targetIds: number[];
        try {
            targetIds = JSON.parse(String(request.body.targetIds || '[]'));
        } catch {
            throw new Error('targetIds must be valid JSON.');
        }
        const jobId = await createUploadJob(
            {
                name: request.body.name,
                targetIds,
                remotePath: request.body.remotePath,
                overwrite: String(request.body.overwrite ?? 'true') !== 'false',
                concurrency: Number(request.body.concurrency),
                timeoutSeconds: Number(request.body.timeoutSeconds),
                ephemeralCredentials: (() => {
                    try { return JSON.parse(String(request.body.ephemeralCredentials || '{}')); }
                    catch { throw new Error('ephemeralCredentials must be valid JSON.'); }
                })(),
                files: files.map(file => ({
                    originalName: sanitizeFilename(file.originalname) || 'uploaded-file',
                    storedPath: file.path,
                    size: file.size,
                })),
            },
            request.session.userId || null,
            request.session.username,
        );
        response.status(202).json({ jobId });
    } catch (error: any) {
        await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => undefined)));
        response.status(400).json({ message: error?.message || 'Invalid upload job.' });
    }
});

router.post('/jobs/:id/cancel', async (request: Request, response: Response) => {
    try {
        const found = await cancelJob(request.params.id, request.session.userId || null, request.session.username);
        if (!found) {
            response.status(404).json({ message: 'Job not found.' });
            return;
        }
        response.status(202).json({ message: 'Cancellation requested.' });
    } catch (error: any) {
        response.status(409).json({ message: error?.message || 'Unable to cancel the job.' });
    }
});

export default router;
