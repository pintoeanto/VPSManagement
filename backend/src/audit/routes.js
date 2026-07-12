import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { listRecentAudit, verifyAuditChain } from './log.js';

export const auditRouter = Router();
auditRouter.use(requireAuth);

auditRouter.get('/', (req, res) => {
  res.json({ entries: listRecentAudit(req.query.limit) });
});

auditRouter.get('/verify', (req, res) => {
  res.json(verifyAuditChain());
});
