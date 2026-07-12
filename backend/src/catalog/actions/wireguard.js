import { z } from 'zod';
import { defineAction } from '../types.js';
import { execReadOnly, runHelperScript } from '../../exec/sudoExec.js';

const peerNameToken = /^[A-Za-z0-9._-]+$/;
const cidrIpv4 = /^([0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}$/;

async function detectWireguard() {
  const [wgCheck, dpkg] = await Promise.all([
    execReadOnly('command', ['-v', 'wg']),
    execReadOnly('dpkg-query', ['-W', '-f=${Status} ${Version}', 'wireguard']),
  ]);
  return {
    installed: dpkg.success && dpkg.stdout.includes('install ok installed'),
    binaryFound: wgCheck.success,
  };
}

const detect = defineAction({
  id: 'wireguard.detect',
  category: 'wireguard',
  label: 'Detect WireGuard install state',
  mutating: false,
  paramsSchema: z.object({}),
  detect: detectWireguard,
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const install = defineAction({
  id: 'wireguard.install',
  category: 'wireguard',
  label: 'Install WireGuard package',
  paramsSchema: z.object({}),
  detect: detectWireguard,
  async plan(_params, detectResult) {
    if (detectResult.installed) return { description: 'Already satisfied', changes: [] };
    return { description: 'Install wireguard via apt', changes: ['apt-get install -y wireguard'] };
  },
  async apply(_params, detectResult) {
    if (detectResult.installed) return { alreadySatisfied: true, ...detectResult };
    const result = await runHelperScript('WIREGUARD_INSTALL', [], { timeoutMs: 120_000 });
    if (!result.success) {
      throw new Error(`wireguard_install failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { alreadySatisfied: false, ...(await detectWireguard()) };
  },
});

const initInterfaceSchema = z.object({
  listenPort: z.coerce.number().int().min(1).max(65535).default(51820),
  serverAddress: z.string().regex(cidrIpv4).default('10.8.0.1/24'),
});

const initInterface = defineAction({
  id: 'wireguard.initInterface',
  category: 'wireguard',
  label: 'Initialize wg0 server interface',
  paramsSchema: initInterfaceSchema,
  async detect() {
    const check = await execReadOnly('command', ['-v', 'wg']);
    return { binaryFound: check.success };
  },
  async plan(params) {
    return { description: `Initialize wg0 with ${params.serverAddress} on port ${params.listenPort} (no-op if already initialized)` };
  },
  async apply(params) {
    const result = await runHelperScript('WIREGUARD_INSTALL', [String(params.listenPort), params.serverAddress]);
    if (!result.success) {
      throw new Error(`wireguard init failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { alreadySatisfied: result.stdout.includes('already initialized'), stdout: result.stdout.trim() };
  },
});

function parseStatus(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean);
  const status = { interface: null, peers: [] };
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts[0] === 'INTERFACE') {
      status.interface = { listenPort: parts[1], publicKey: parts[2] };
    } else if (parts[0] === 'PEER') {
      status.peers.push({
        name: parts[1],
        publicKey: parts[2],
        endpoint: parts[3] === '(none)' ? null : parts[3],
        allowedIps: parts[4],
        latestHandshake: parts[5] === '0' ? null : parts[5],
        rxBytes: Number(parts[6] ?? 0),
        txBytes: Number(parts[7] ?? 0),
      });
    }
  }
  return status;
}

const status = defineAction({
  id: 'wireguard.status',
  category: 'wireguard',
  label: 'WireGuard interface + peer status',
  mutating: false,
  paramsSchema: z.object({}),
  async detect() {
    const result = await runHelperScript('WIREGUARD_STATUS', []);
    if (!result.success) return { initialized: false, error: result.stderr.trim() };
    return { initialized: true, ...parseStatus(result.stdout) };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const peerList = defineAction({
  id: 'wireguard.peerList',
  category: 'wireguard',
  label: 'List WireGuard peers',
  mutating: false,
  paramsSchema: z.object({}),
  async detect() {
    const result = await runHelperScript('WIREGUARD_STATUS', []);
    if (!result.success) return { peers: [] };
    return { peers: parseStatus(result.stdout).peers };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const peerAddSchema = z.object({
  peerName: z.string().min(1).max(64).regex(peerNameToken),
  allowedIps: z.string().regex(cidrIpv4),
});

function parsePeerAddOutput(stdout) {
  const out = {};
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

const peerAdd = defineAction({
  id: 'wireguard.peerAdd',
  category: 'wireguard',
  label: 'Add a WireGuard peer',
  paramsSchema: peerAddSchema,
  async detect(params) {
    const result = await runHelperScript('WIREGUARD_STATUS', []);
    const existing = result.success ? parseStatus(result.stdout).peers : [];
    return { exists: existing.some((p) => p.name === params.peerName) };
  },
  async plan(params, detectResult) {
    if (detectResult.exists) return { description: 'Already satisfied (peer exists)', changes: [] };
    return { description: `Add peer ${params.peerName} with allowedIps ${params.allowedIps}` };
  },
  async apply(params, detectResult) {
    if (detectResult.exists) return { alreadySatisfied: true };
    const result = await runHelperScript('WIREGUARD_PEER_ADD', [params.peerName, params.allowedIps]);
    if (!result.success) {
      throw new Error(`wireguard_peer_add failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    const parsed = parsePeerAddOutput(result.stdout);
    // The client private key is returned exactly once here and never persisted server-side.
    return { alreadySatisfied: false, ...parsed };
  },
});

const peerRemoveSchema = z.object({ peerName: z.string().min(1).max(64).regex(peerNameToken) });

const peerRemove = defineAction({
  id: 'wireguard.peerRemove',
  category: 'wireguard',
  label: 'Remove a WireGuard peer',
  paramsSchema: peerRemoveSchema,
  async detect(params) {
    const result = await runHelperScript('WIREGUARD_STATUS', []);
    const existing = result.success ? parseStatus(result.stdout).peers : [];
    return { exists: existing.some((p) => p.name === params.peerName) };
  },
  async plan(params, detectResult) {
    if (!detectResult.exists) return { description: 'Already satisfied (no such peer)', changes: [] };
    return { description: `Remove peer ${params.peerName}` };
  },
  async apply(params, detectResult) {
    if (!detectResult.exists) return { alreadySatisfied: true };
    const result = await runHelperScript('WIREGUARD_PEER_REMOVE', [params.peerName]);
    if (!result.success) {
      throw new Error(`wireguard_peer_remove failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { alreadySatisfied: false, stdout: result.stdout.trim() };
  },
});

export const wireguardActions = [detect, install, initInterface, status, peerList, peerAdd, peerRemove];
