import { Router } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { getAction } from '../catalog/index.js';

export const metricsRouter = Router();
metricsRouter.use(requireAuth);

// Thin GET convenience wrapper around the system.metrics catalog action, for
// simple dashboard polling without needing a POST body.
metricsRouter.get('/', async (req, res, next) => {
  try {
    const action = getAction('system.metrics');
    const detectResult = await action.detect({});
    res.json(detectResult);
  } catch (err) {
    next(err);
  }
});
