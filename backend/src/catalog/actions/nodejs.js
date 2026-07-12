import { z } from 'zod';
import { defineAction } from '../types.js';
import { execReadOnly, runHelperScript } from '../../exec/sudoExec.js';

async function detectNode() {
  const result = await execReadOnly('node', ['-v']);
  if (!result.success) return { installed: false, version: null, major: null };
  const version = result.stdout.trim(); // e.g. "v20.11.1"
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  return { installed: true, version, major };
}

const detect = defineAction({
  id: 'nodejs.detect',
  category: 'nodejs',
  label: 'Detect installed Node.js version',
  mutating: false,
  paramsSchema: z.object({}),
  detect: detectNode,
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const installSchema = z.object({
  majorVersion: z.coerce.number().int().min(12).max(99).default(20),
  confirmOverride: z.boolean().default(false),
});

const install = defineAction({
  id: 'nodejs.install',
  category: 'nodejs',
  label: 'Install a pinned Node.js LTS major version',
  paramsSchema: installSchema,
  detect: detectNode,
  async plan(params, detectResult) {
    if (!detectResult.installed) {
      return { description: `Install Node.js ${params.majorVersion}.x via NodeSource`, changes: ['nodesource setup', 'apt-get install -y nodejs'] };
    }
    if (detectResult.major === params.majorVersion) {
      return { description: 'Already satisfied', changes: [] };
    }
    return {
      description: `Installed Node.js is v${detectResult.major}.x, requested v${params.majorVersion}.x — requires confirmOverride`,
      changes: params.confirmOverride ? ['nodesource setup', 'apt-get install -y nodejs (replace existing)'] : [],
      conflict: true,
    };
  },
  async apply(params, detectResult) {
    if (detectResult.installed && detectResult.major === params.majorVersion) {
      return { alreadySatisfied: true, ...detectResult };
    }
    if (detectResult.installed && detectResult.major !== params.majorVersion && !params.confirmOverride) {
      throw new Error(
        `Node.js v${detectResult.major}.x is already installed. Set confirmOverride=true to replace it with v${params.majorVersion}.x.`
      );
    }
    const result = await runHelperScript('NODEJS_INSTALL', [String(params.majorVersion)], { timeoutMs: 180_000 });
    if (!result.success) {
      throw new Error(`nodejs_install failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { alreadySatisfied: false, ...(await detectNode()) };
  },
});

export const nodejsActions = [detect, install];
