import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { HttpError } from '../middleware/errorHandler.js';
import { recordAudit } from '../audit/log.js';
import { enqueue } from '../catalog/queue.js';
import * as routes from '../db/nginxRoutes.js';
import { validateRouteCandidate, validateHostnameFormat, validateConfigFileName, generateConfigFileName } from '../services/routeValidation.js';
import { deployRoute } from '../services/nginxRouteDeployer.js';

export const nginxRoutesRouter = Router();
nginxRoutesRouter.use(requireAuth);

const candidateSchema = z.object({
  hostname: z.string().min(1).max(253),
  configFileName: z.string().min(1).max(122).optional(),
  backendProtocol: z.enum(['http', 'https']).default('http'),
  backendHost: z.string().min(1).max(253).optional(),
  backendPort: z.coerce.number().int().min(1).max(65535).optional(),
  backendBasePath: z.string().max(500).optional(),
});

nginxRoutesRouter.post('/validate', async (req, res, next) => {
  try {
    const input = candidateSchema.parse(req.body ?? {});
    const configFileName = input.configFileName || generateConfigFileName(input.hostname);
    const result = await validateRouteCandidate({ ...input, configFileName });
    res.json({ ...result, suggestedConfigFileName: configFileName });
  } catch (err) {
    next(err);
  }
});

nginxRoutesRouter.get('/', (req, res) => {
  res.json({ routes: routes.listRoutes() });
});

nginxRoutesRouter.get('/:id', (req, res, next) => {
  const route = routes.getRoute(Number(req.params.id));
  if (!route) return next(new HttpError(404, 'Route not found'));
  res.json({ route });
});

nginxRoutesRouter.get('/:id/health-history', (req, res, next) => {
  const route = routes.getRoute(Number(req.params.id));
  if (!route) return next(new HttpError(404, 'Route not found'));
  res.json({ history: routes.getHealthHistory(route.id, req.query.limit) });
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  projectName: z.string().max(200).optional(),
  publicHostname: z.string().min(1).max(253),
  configFileName: z.string().min(1).max(122).optional(),
  backendProtocol: z.enum(['http', 'https']).default('http'),
  backendHost: z.string().min(1).max(253),
  backendPort: z.coerce.number().int().min(1).max(65535),
  backendBasePath: z.string().max(500).default('/'),
  healthCheckPath: z.string().max(500).default('/'),
  preserveIncomingPath: z.boolean().default(true),
  websocketEnabled: z.boolean().default(false),
  ignoreBackendTlsErrors: z.boolean().default(false),
  connectTimeoutSeconds: z.coerce.number().int().min(1).max(300).default(10),
  readTimeoutSeconds: z.coerce.number().int().min(1).max(3600).default(60),
  sendTimeoutSeconds: z.coerce.number().int().min(1).max(3600).default(60),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  supportEmail: z.string().email().optional(),
  supportPhone: z.string().max(50).optional(),
  portalUrl: z.string().url().optional(),
  notes: z.string().max(4000).optional(),
});

nginxRoutesRouter.post('/', async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body ?? {});
    const configFileName = input.configFileName || generateConfigFileName(input.publicHostname);

    const hostnameFormat = validateHostnameFormat(input.publicHostname);
    if (!hostnameFormat.valid) throw new HttpError(400, hostnameFormat.reason);
    const fileNameFormat = validateConfigFileName(configFileName);
    if (!fileNameFormat.valid) throw new HttpError(400, fileNameFormat.reason);
    if (routes.getRouteByConfigFileName(configFileName)) {
      throw new HttpError(409, `A route with configuration file name "${configFileName}" already exists`);
    }
    if (routes.getRouteByHostname(input.publicHostname)) {
      throw new HttpError(409, `A route for "${input.publicHostname}" already exists`);
    }

    const route = routes.createRoute({ ...input, configFileName });
    recordAudit({
      userId: req.user.id,
      username: req.user.username,
      actionId: 'nginx.route.create',
      phase: 'apply',
      params: input,
      result: { routeId: route.id },
      success: true,
    });
    res.status(201).json({ route });
  } catch (err) {
    next(err);
  }
});

const deploySchema = z.object({
  issueTls: z.boolean().default(false),
  certbotEmail: z.string().email().optional(),
})
  .refine((v) => !v.issueTls || !!v.certbotEmail, { message: 'certbotEmail is required when issueTls is true', path: ['certbotEmail'] });

nginxRoutesRouter.post('/:id/deploy', async (req, res, next) => {
  const route = routes.getRoute(Number(req.params.id));
  if (!route) return next(new HttpError(404, 'Route not found'));

  let input;
  try {
    input = deploySchema.parse(req.body ?? {});
  } catch (err) {
    return next(err);
  }

  let result;
  let success = true;
  let errorMessage = null;
  try {
    result = await enqueue(() => deployRoute(route, input));
  } catch (err) {
    success = false;
    errorMessage = err.message;
  }

  recordAudit({
    userId: req.user.id,
    username: req.user.username,
    actionId: 'nginx.route.deploy',
    phase: 'apply',
    params: { routeId: route.id, hostname: route.public_hostname, issueTls: input.issueTls },
    result: success ? result : { error: errorMessage },
    success: success && (result?.success ?? false),
  });

  if (!success) return res.status(500).json({ error: errorMessage });
  res.json(result);
});

nginxRoutesRouter.delete('/:id', (req, res, next) => {
  const route = routes.getRoute(Number(req.params.id));
  if (!route) return next(new HttpError(404, 'Route not found'));
  routes.deleteRoute(route.id);
  recordAudit({
    userId: req.user.id,
    username: req.user.username,
    actionId: 'nginx.route.deleteMetadata',
    phase: 'apply',
    params: { routeId: route.id, hostname: route.public_hostname },
    result: { note: 'Metadata only — NGINX files/certificates were not touched' },
    success: true,
  });
  res.json({ ok: true });
});
