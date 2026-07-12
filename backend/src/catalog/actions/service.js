import { z } from 'zod';
import { defineAction } from '../types.js';
import { execReadOnly, runHelperScript } from '../../exec/sudoExec.js';
import { config } from '../../config.js';

const unitSchema = z.string().refine((u) => config.ALLOWED_SERVICE_UNITS.includes(u), {
  message: 'Unit is not in the allowed whitelist',
});

async function readUnitState(unit) {
  const props = 'ActiveState,SubState,LoadState,UnitFileState,Description';
  const result = await execReadOnly('systemctl', ['show', unit, `--property=${props}`]);
  if (!result.success) {
    return { unit, found: false, raw: result.stderr.trim() };
  }
  const state = { unit, found: true };
  for (const line of result.stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    state[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return state;
}

const listUnits = defineAction({
  id: 'service.list',
  category: 'service',
  label: 'List managed services',
  mutating: false,
  paramsSchema: z.object({}),
  async detect() {
    const states = await Promise.all(config.ALLOWED_SERVICE_UNITS.map(readUnitState));
    return { units: states };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const controlSchema = z.object({
  unit: unitSchema,
  action: z.enum(['start', 'stop', 'restart', 'enable', 'disable']),
});

const control = defineAction({
  id: 'service.control',
  category: 'service',
  label: 'Start/stop/restart/enable/disable a service',
  paramsSchema: controlSchema,
  async detect(params) {
    return readUnitState(params.unit);
  },
  async plan(params, detectResult) {
    return {
      description: `${params.action} ${params.unit}`,
      currentState: detectResult,
    };
  },
  async apply(params) {
    const result = await runHelperScript('SERVICE_CTL', [params.unit, params.action]);
    if (!result.success) {
      throw new Error(`service_ctl failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { ...result, newState: await readUnitState(params.unit) };
  },
});

const logsSchema = z.object({
  unit: unitSchema,
  lines: z.coerce.number().int().min(1).max(500).default(100),
});

const logs = defineAction({
  id: 'service.logs',
  category: 'service',
  label: 'Tail recent logs for a service (read-only, bounded)',
  mutating: false,
  paramsSchema: logsSchema,
  async detect(params) {
    return readUnitState(params.unit);
  },
  async plan() {
    return { changes: [] };
  },
  async apply(params) {
    const result = await runHelperScript('JOURNALCTL_TAIL', [params.unit, String(params.lines)]);
    if (!result.success) {
      throw new Error(`journalctl_tail failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { lines: result.stdout.split('\n').filter(Boolean) };
  },
});

export const serviceActions = [listUnits, control, logs];
