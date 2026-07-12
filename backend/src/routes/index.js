import { Router } from 'express';
import { authRouter } from '../auth/routes.js';
import { catalogRouter } from './catalogRoutes.js';
import { metricsRouter } from './metricsRoutes.js';
import { fileRouter } from '../fileTransfer/routes.js';
import { auditRouter } from '../audit/routes.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/actions', catalogRouter);
apiRouter.use('/metrics', metricsRouter);
apiRouter.use('/files', fileRouter);
apiRouter.use('/audit', auditRouter);
