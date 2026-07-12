import os from 'node:os';
import { z } from 'zod';
import { defineAction } from '../types.js';
import { execReadOnly, runHelperScript } from '../../exec/sudoExec.js';

function parseDf(stdout) {
  const lines = stdout.trim().split('\n').slice(1);
  return lines.map((line) => {
    const parts = line.trim().split(/\s+/);
    const [filesystem, size, used, avail, usePercent, mounted] = parts;
    return { filesystem, size, used, avail, usePercent, mounted };
  });
}

const metrics = defineAction({
  id: 'system.metrics',
  category: 'system',
  label: 'System metrics (CPU/mem/disk/uptime)',
  mutating: false,
  paramsSchema: z.object({}),
  async detect() {
    const df = await execReadOnly('df', ['-h', '-x', 'tmpfs', '-x', 'devtmpfs']);
    return {
      loadAvg: os.loadavg(),
      cpuCount: os.cpus().length,
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
      hostname: os.hostname(),
      disks: df.success ? parseDf(df.stdout) : [],
    };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const aptListUpgradable = defineAction({
  id: 'system.apt.listUpgradable',
  category: 'system',
  label: 'List upgradable packages',
  mutating: false,
  paramsSchema: z.object({}),
  async detect() {
    const result = await execReadOnly('apt', ['list', '--upgradable']);
    const packages = result.success
      ? result.stdout
          .split('\n')
          .filter((l) => l && !l.startsWith('Listing...'))
      : [];
    return { packages, count: packages.length };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const aptUpgrade = defineAction({
  id: 'system.apt.upgrade',
  category: 'system',
  label: 'apt-get update && upgrade',
  paramsSchema: z.object({ confirm: z.literal(true) }),
  async detect() {
    const result = await execReadOnly('apt', ['list', '--upgradable']);
    const packages = result.success ? result.stdout.split('\n').filter((l) => l && !l.startsWith('Listing...')) : [];
    return { packages, count: packages.length };
  },
  async plan(_params, detectResult) {
    return { description: `Upgrade ${detectResult.count} package(s)`, packages: detectResult.packages };
  },
  async apply() {
    const result = await runHelperScript('SYSTEM_UPDATE', ['upgrade'], { timeoutMs: 10 * 60_000 });
    if (!result.success) {
      throw new Error(`system_update failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { stdout: result.stdout.split('\n').slice(-100) };
  },
});

const ufwStatus = defineAction({
  id: 'system.ufw.status',
  category: 'system',
  label: 'ufw firewall status',
  mutating: false,
  paramsSchema: z.object({}),
  async detect() {
    const result = await runHelperScript('UFW_RULE', ['status']);
    return { raw: result.stdout, success: result.success };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const ufwRuleSchema = z.object({
  mode: z.enum(['allow', 'deny', 'delete-allow', 'delete-deny']),
  port: z.coerce.number().int().min(1).max(65535),
  proto: z.enum(['tcp', 'udp']),
});

const ufwSetRule = defineAction({
  id: 'system.ufw.setRule',
  category: 'system',
  label: 'Add/remove a ufw rule',
  paramsSchema: ufwRuleSchema,
  async detect() {
    const result = await runHelperScript('UFW_RULE', ['status']);
    return { raw: result.stdout };
  },
  async plan(params) {
    return { description: `${params.mode} ${params.port}/${params.proto}` };
  },
  async apply(params) {
    const result = await runHelperScript('UFW_RULE', [params.mode, String(params.port), params.proto]);
    if (!result.success) {
      throw new Error(`ufw_rule failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { stdout: result.stdout.trim() };
  },
});

export const systemActions = [metrics, aptListUpgradable, aptUpgrade, ufwStatus, ufwSetRule];
