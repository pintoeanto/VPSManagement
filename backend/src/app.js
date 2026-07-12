import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { securityHeaders, requireTls } from './middleware/security.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';

export function createApp() {
  const app = express();

  // We sit behind our own NGINX reverse proxy (or a tunnel to one) on the
  // same host, connecting over loopback — trust X-Forwarded-* only from there.
  app.set('trust proxy', 'loopback');

  app.use(securityHeaders());
  app.use(requireTls);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  if (!config.isProduction && config.DEV_CORS_ORIGIN) {
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', config.DEV_CORS_ORIGIN);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-CSRF-Token');
      res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      next();
    });
  }

  app.use('/api', apiRouter);

  const frontendDist = path.resolve(config.repoRoot, '..', 'frontend', 'dist');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get(/^(?!\/api).*/, (req, res) => {
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}
