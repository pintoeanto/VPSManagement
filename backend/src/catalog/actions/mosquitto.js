import { z } from 'zod';
import { defineAction } from '../types.js';
import { execReadOnly, runHelperScript } from '../../exec/sudoExec.js';

const usernameToken = /^[A-Za-z0-9._-]+$/;
const absolutePath = /^\/[A-Za-z0-9._/-]+$/;

async function detectMosquitto() {
  const dpkg = await execReadOnly('dpkg-query', ['-W', '-f=${Status} ${Version}', 'mosquitto']);
  return { installed: dpkg.success && dpkg.stdout.includes('install ok installed') };
}

const detect = defineAction({
  id: 'mosquitto.detect',
  category: 'mosquitto',
  label: 'Detect Mosquitto install state',
  mutating: false,
  paramsSchema: z.object({}),
  detect: detectMosquitto,
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const install = defineAction({
  id: 'mosquitto.install',
  category: 'mosquitto',
  label: 'Install Mosquitto MQTT broker',
  paramsSchema: z.object({}),
  detect: detectMosquitto,
  async plan(_params, detectResult) {
    if (detectResult.installed) return { description: 'Already satisfied', changes: [] };
    return { description: 'Install mosquitto via apt', changes: ['apt-get install -y mosquitto mosquitto-clients'] };
  },
  async apply(_params, detectResult) {
    if (detectResult.installed) return { alreadySatisfied: true, ...detectResult };
    const result = await runHelperScript('MOSQUITTO_INSTALL', [], { timeoutMs: 120_000 });
    if (!result.success) {
      throw new Error(`mosquitto_install failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { alreadySatisfied: false, ...(await detectMosquitto()) };
  },
});

const configureListenerSchema = z
  .object({
    port: z.coerce.number().int().min(1).max(65535).default(1883),
    allowAnonymous: z.boolean().default(false),
    tlsEnabled: z.boolean().default(false),
    certPath: z.string().regex(absolutePath).optional(),
    keyPath: z.string().regex(absolutePath).optional(),
  })
  .refine((v) => !v.tlsEnabled || (v.certPath && v.keyPath), {
    message: 'certPath and keyPath are required when tlsEnabled is true',
    path: ['certPath'],
  });

const configureListener = defineAction({
  id: 'mosquitto.configureListener',
  category: 'mosquitto',
  label: 'Configure Mosquitto listener',
  paramsSchema: configureListenerSchema,
  async detect() {
    const check = await execReadOnly('dpkg-query', ['-W', '-f=${Status}', 'mosquitto']);
    return { installed: check.success && check.stdout.includes('install ok installed') };
  },
  async plan(params) {
    return {
      description: `listener ${params.port}, allowAnonymous=${params.allowAnonymous}, tls=${params.tlsEnabled}`,
    };
  },
  async apply(params) {
    const args = [
      'listener',
      String(params.port),
      params.allowAnonymous ? '1' : '0',
      params.tlsEnabled ? '1' : '0',
    ];
    if (params.tlsEnabled) args.push(params.certPath, params.keyPath);
    const result = await runHelperScript('MOSQUITTO_CONFIGURE', args);
    if (!result.success) {
      throw new Error(`mosquitto_configure failed, rolled back (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { stdout: result.stdout.trim() };
  },
});

const listUsers = defineAction({
  id: 'mosquitto.listUsers',
  category: 'mosquitto',
  label: 'List Mosquitto password-file users',
  mutating: false,
  paramsSchema: z.object({}),
  async detect() {
    const result = await runHelperScript('MOSQUITTO_CONFIGURE', ['listusers']);
    const users = result.success ? result.stdout.trim().split('\n').filter(Boolean) : [];
    return { users };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const setUserSchema = z.object({
  username: z.string().min(1).max(64).regex(usernameToken),
  password: z.string().min(8).max(256),
});

const setUser = defineAction({
  id: 'mosquitto.setUser',
  category: 'mosquitto',
  label: 'Create/update a Mosquitto user',
  paramsSchema: setUserSchema,
  async detect(params) {
    const result = await runHelperScript('MOSQUITTO_CONFIGURE', ['listusers']);
    const users = result.success ? result.stdout.trim().split('\n').filter(Boolean) : [];
    return { exists: users.includes(params.username) };
  },
  async plan(params, detectResult) {
    return { description: detectResult.exists ? `Update password for ${params.username}` : `Create user ${params.username}` };
  },
  async apply(params) {
    const result = await runHelperScript('MOSQUITTO_CONFIGURE', ['adduser', params.username, params.password]);
    if (!result.success) {
      throw new Error(`mosquitto_configure adduser failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { stdout: result.stdout.trim() };
  },
});

const removeUserSchema = z.object({ username: z.string().min(1).max(64).regex(usernameToken) });

const removeUser = defineAction({
  id: 'mosquitto.removeUser',
  category: 'mosquitto',
  label: 'Remove a Mosquitto user',
  paramsSchema: removeUserSchema,
  async detect(params) {
    const result = await runHelperScript('MOSQUITTO_CONFIGURE', ['listusers']);
    const users = result.success ? result.stdout.trim().split('\n').filter(Boolean) : [];
    return { exists: users.includes(params.username) };
  },
  async plan(params, detectResult) {
    if (!detectResult.exists) return { description: 'Already satisfied (no such user)', changes: [] };
    return { description: `Remove user ${params.username}` };
  },
  async apply(params, detectResult) {
    if (!detectResult.exists) return { alreadySatisfied: true };
    const result = await runHelperScript('MOSQUITTO_CONFIGURE', ['removeuser', params.username]);
    if (!result.success) {
      throw new Error(`mosquitto_configure removeuser failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { alreadySatisfied: false, stdout: result.stdout.trim() };
  },
});

export const mosquittoActions = [detect, install, configureListener, listUsers, setUser, removeUser];
