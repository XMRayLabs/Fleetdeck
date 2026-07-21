import fs from 'fs';
import path from 'path';
import { Request, Response, Router } from 'express';
import multer from 'multer';
import sanitizeFilename from 'sanitize-filename';
import { v4 as uuidv4 } from 'uuid';
import { isAuthenticated } from '../auth/auth.middleware';
import {
    addPlaybookFiles,
    createPlaybook,
    deletePlaybook,
    deletePlaybookFile,
    executePlaybook,
    getPlaybook,
    listPlaybooks,
    playbookFilesDirectory,
    playbookUploadIngressDirectory,
    updatePlaybook,
} from './playbook.service';

const router = Router();
fs.mkdirSync(playbookFilesDirectory, { recursive: true, mode: 0o700 });
fs.mkdirSync(playbookUploadIngressDirectory, { recursive: true, mode: 0o700 });
try { fs.chmodSync(playbookFilesDirectory, 0o700); } catch { /* Windows does not enforce POSIX modes. */ }
try { fs.chmodSync(playbookUploadIngressDirectory, 0o700); } catch { /* Windows does not enforce POSIX modes. */ }

const maxUploadBytes = Math.max(1, Number(process.env.BATCH_UPLOAD_MAX_MB || 200)) * 1024 * 1024;
const upload = multer({
    storage: multer.diskStorage({
        destination: playbookUploadIngressDirectory,
        filename: (_request, file, callback) => {
            const extension = path.extname(sanitizeFilename(file.originalname)).slice(0, 32);
            callback(null, `${uuidv4()}${extension}`);
        },
    }),
    limits: { fileSize: maxUploadBytes, files: 20 },
});

router.use(isAuthenticated);

router.get('/', async (_request: Request, response: Response) => {
    try {
        response.json({ playbooks: await listPlaybooks() });
    } catch (error: any) {
        response.status(500).json({ message: error?.message || 'Failed to list playbooks.' });
    }
});

router.get('/:id', async (request: Request, response: Response) => {
    try {
        const playbook = await getPlaybook(request.params.id);
        if (!playbook) {
            response.status(404).json({ message: 'Playbook not found.' });
            return;
        }
        response.json({ playbook });
    } catch (error: any) {
        response.status(500).json({ message: error?.message || 'Failed to load the playbook.' });
    }
});

router.post('/', async (request: Request, response: Response) => {
    try {
        const playbook = await createPlaybook(request.body, request.session.userId || null, request.session.username);
        response.status(201).json({ playbook });
    } catch (error: any) {
        response.status(400).json({ message: error?.message || 'Invalid playbook.' });
    }
});

router.put('/:id', async (request: Request, response: Response) => {
    try {
        const playbook = await updatePlaybook(
            request.params.id,
            request.body,
            request.session.userId || null,
            request.session.username,
        );
        if (!playbook) {
            response.status(404).json({ message: 'Playbook not found.' });
            return;
        }
        response.json({ playbook });
    } catch (error: any) {
        response.status(400).json({ message: error?.message || 'Invalid playbook.' });
    }
});

router.post('/:id/files', upload.array('files', 20), async (request: Request, response: Response) => {
    const files = ((request.files as Express.Multer.File[] | undefined) || []).map(file => ({
        ...file,
        originalname: sanitizeFilename(file.originalname) || 'playbook-file',
    }));
    try {
        if (files.length === 0) throw new Error('Please choose at least one attachment.');
        const playbook = await addPlaybookFiles(request.params.id, files);
        if (!playbook) {
            await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => undefined)));
            response.status(404).json({ message: 'Playbook not found.' });
            return;
        }
        response.status(201).json({ playbook });
    } catch (error: any) {
        await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => undefined)));
        response.status(400).json({ message: error?.message || 'Unable to add attachments.' });
    }
});

router.delete('/:id/files/:fileId', async (request: Request, response: Response) => {
    try {
        const deleted = await deletePlaybookFile(request.params.id, request.params.fileId);
        if (!deleted) {
            response.status(404).json({ message: 'Playbook attachment not found.' });
            return;
        }
        response.status(204).send();
    } catch (error: any) {
        response.status(409).json({ message: error?.message || 'Unable to delete the attachment.' });
    }
});

router.post('/:id/run', async (request: Request, response: Response) => {
    try {
        const jobId = await executePlaybook(
            request.params.id,
            request.body,
            request.session.userId || null,
            request.session.username,
        );
        if (!jobId) {
            response.status(404).json({ message: 'Playbook not found.' });
            return;
        }
        response.status(202).json({ jobId });
    } catch (error: any) {
        response.status(400).json({ message: error?.message || 'Unable to execute the playbook.' });
    }
});

router.delete('/:id', async (request: Request, response: Response) => {
    try {
        const deleted = await deletePlaybook(
            request.params.id,
            request.session.userId || null,
            request.session.username,
        );
        if (!deleted) {
            response.status(404).json({ message: 'Playbook not found.' });
            return;
        }
        response.status(204).send();
    } catch (error: any) {
        response.status(500).json({ message: error?.message || 'Unable to delete the playbook.' });
    }
});

export default router;
