import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { resolveJailPath, resolveExistingJailPath, jailRoot, JailViolationError } from './jail.js';
import { recordAudit } from '../audit/log.js';
import { HttpError } from '../middleware/errorHandler.js';

export const fileRouter = Router();
fileRouter.use(requireAuth);

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100MB
const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.conf', '.cfg', '.ini', '.json', '.yaml', '.yml', '.env',
  '.pem', '.crt', '.key', '.csr', '.log', '.md', '.sh',
  '.tar', '.gz', '.tgz', '.zip', '.service',
]);

function safeBasename(originalname) {
  const base = path.basename(originalname).replace(/[^A-Za-z0-9._ -]/g, '_');
  return base.length > 0 ? base : 'file';
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const dir = resolveJailPath(req.query.dir?.toString() ?? '.');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    cb(null, safeBasename(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(safeBasename(file.originalname)).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new HttpError(400, `File extension not allowed: ${ext || '(none)'}`));
    }
    cb(null, true);
  },
});

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

fileRouter.get('/', (req, res, next) => {
  try {
    const dir = resolveExistingJailPath(req.query.dir?.toString() ?? '.');
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full);
      return {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    });
    res.json({ dir: path.relative(jailRoot(), dir) || '.', entries });
  } catch (err) {
    if (err instanceof JailViolationError) return next(new HttpError(400, err.message));
    next(err);
  }
});

fileRouter.post('/upload', (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return next(new HttpError(413, `File exceeds max size of ${MAX_UPLOAD_BYTES} bytes`));
      }
      return next(err instanceof HttpError ? err : new HttpError(400, err.message));
    }
    if (!req.file) return next(new HttpError(400, 'No file provided'));

    try {
      const checksum = await sha256File(req.file.path);
      const relPath = path.relative(jailRoot(), req.file.path);
      recordAudit({
        userId: req.user.id,
        username: req.user.username,
        actionId: 'files.upload',
        phase: 'apply',
        params: { dir: req.query.dir ?? '.', filename: req.file.filename },
        result: { path: relPath, size: req.file.size, sha256: checksum },
        success: true,
      });
      res.json({ path: relPath, size: req.file.size, sha256: checksum });
    } catch (e) {
      next(e);
    }
  });
});

fileRouter.get('/download', (req, res, next) => {
  try {
    const parsed = z.object({ path: z.string().min(1) }).safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'path query param is required');
    const filePath = resolveExistingJailPath(parsed.data.path);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) throw new HttpError(400, 'Cannot download a directory');
    res.download(filePath, path.basename(filePath));
  } catch (err) {
    if (err instanceof JailViolationError) return next(new HttpError(400, err.message));
    next(err);
  }
});

fileRouter.get('/checksum', async (req, res, next) => {
  try {
    const parsed = z.object({ path: z.string().min(1) }).safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'path query param is required');
    const filePath = resolveExistingJailPath(parsed.data.path);
    if (fs.statSync(filePath).isDirectory()) throw new HttpError(400, 'Cannot checksum a directory');
    res.json({ sha256: await sha256File(filePath) });
  } catch (err) {
    if (err instanceof JailViolationError) return next(new HttpError(400, err.message));
    next(err);
  }
});

fileRouter.delete('/', (req, res, next) => {
  try {
    const parsed = z.object({ path: z.string().min(1) }).safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, 'path query param is required');
    const filePath = resolveExistingJailPath(parsed.data.path);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmdirSync(filePath);
    } else {
      fs.unlinkSync(filePath);
    }
    recordAudit({
      userId: req.user.id,
      username: req.user.username,
      actionId: 'files.delete',
      phase: 'apply',
      params: { path: parsed.data.path },
      success: true,
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof JailViolationError) return next(new HttpError(400, err.message));
    next(err);
  }
});
