import { Router } from 'express';
import { getAction, listActions } from '../catalog/index.js';
import { enqueue } from '../catalog/queue.js';
import { requireAuth } from '../auth/middleware.js';
import { recordAudit } from '../audit/log.js';
import { HttpError } from '../middleware/errorHandler.js';

export const catalogRouter = Router();
catalogRouter.use(requireAuth);

function loadAction(req) {
  const action = getAction(req.params.id);
  if (!action) throw new HttpError(404, `Unknown action: ${req.params.id}`);
  return action;
}

catalogRouter.get('/', (req, res) => {
  res.json({ actions: listActions() });
});

catalogRouter.post('/:id/detect', async (req, res, next) => {
  try {
    const action = loadAction(req);
    const params = action.paramsSchema.parse(req.body ?? {});
    const detectResult = await action.detect(params);
    res.json({ detect: detectResult });
  } catch (err) {
    next(err);
  }
});

catalogRouter.post('/:id/plan', async (req, res, next) => {
  try {
    const action = loadAction(req);
    const params = action.paramsSchema.parse(req.body ?? {});
    const detectResult = await action.detect(params);
    const planResult = await action.plan(params, detectResult);
    res.json({ detect: detectResult, plan: planResult });
  } catch (err) {
    next(err);
  }
});

catalogRouter.post('/:id/apply', async (req, res, next) => {
  let action;
  let params;
  try {
    action = loadAction(req);
    params = action.paramsSchema.parse(req.body ?? {});
  } catch (err) {
    return next(err);
  }

  const run = async () => {
    const detectResult = await action.detect(params);
    const planResult = await action.plan(params, detectResult);
    const applyResult = await action.apply(params, detectResult, planResult);
    return { detectResult, planResult, applyResult };
  };

  let outcome = { detectResult: null, planResult: null, applyResult: null };
  let success = true;
  let errorMessage = null;
  try {
    outcome = action.mutating ? await enqueue(run) : await run();
  } catch (err) {
    success = false;
    errorMessage = err.message;
  }

  recordAudit({
    userId: req.user.id,
    username: req.user.username,
    actionId: action.id,
    phase: 'apply',
    params,
    detect: outcome.detectResult,
    result: success ? outcome.applyResult : { error: errorMessage },
    success,
  });

  if (!success) {
    return res.status(500).json({ error: errorMessage, detect: outcome.detectResult });
  }
  res.json({ detect: outcome.detectResult, plan: outcome.planResult, result: outcome.applyResult });
});
