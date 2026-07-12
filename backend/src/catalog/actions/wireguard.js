import { z } from 'zod';
import { defineAction } from '../types.js';
import { execReadOnly, runHelperScript } from '../../exec/sudoExec.js';
import { checkFirewallPort } from '../../services/firewallCheck.js';
import { tryHelperCheck } from '../../services/tryHelperCheck.js';

const peerNameToken = /^[A-Za-z0-9._-]+$/;
const cidrIpv4 = /^([0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}$/;
// A peer's AllowedIPs is a comma-separated list in real WireGuard configs
// (gateway peers route more than just their own /32 — see isGatewayPeer on
// the frontend) — a single-CIDR-only schema would reject re-submitting an
// existing gateway peer's value unchanged, so peer add/update both accept
// the list form; only the interface's own serverAddress is genuinely single.
const allowedIpsList = z.string().refine(
  (v) => v.split(',').map((s) => s.trim()).filter(Boolean).length > 0 && v.split(',').every((s) => cidrIpv4.test(s.trim())),
  { message: 'Must be a comma-separated list of CIDR blocks, e.g. 10.8.0.2/32, 192.168.50.0/24' }
);
// Interface names this tool manages are restricted to the wgN convention —
// must match validate_wg_interface_name in scripts/lib/common.sh exactly.
const interfaceNameToken = /^wg[0-9]{1,3}$/;
const interfaceNameSchema = z.string().regex(interfaceNameToken, 'Interface name must look like wg0, wg1, ...');

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
    const result = await runHelperScript('WIREGUARD_INSTALL', ['wg0'], { timeoutMs: 120_000 });
    if (!result.success) {
      throw new Error(`wireguard_install failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { alreadySatisfied: false, ...(await detectWireguard()) };
  },
});

const initInterfaceSchema = z.object({
  interfaceName: interfaceNameSchema,
  listenPort: z.coerce.number().int().min(1).max(65535).default(51820),
  serverAddress: z.string().regex(cidrIpv4).default('10.8.0.1/24'),
});

const initInterface = defineAction({
  id: 'wireguard.initInterface',
  category: 'wireguard',
  label: 'Initialize a WireGuard tunnel interface',
  paramsSchema: initInterfaceSchema,
  async detect() {
    const check = await execReadOnly('command', ['-v', 'wg']);
    return { binaryFound: check.success };
  },
  async plan(params) {
    return { description: `Initialize ${params.interfaceName} with ${params.serverAddress} on port ${params.listenPort} (no-op if already initialized)` };
  },
  async apply(params) {
    const result = await runHelperScript('WIREGUARD_INSTALL', [params.interfaceName, String(params.listenPort), params.serverAddress]);
    if (!result.success) {
      throw new Error(`wireguard init failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { alreadySatisfied: result.stdout.includes('already initialized'), stdout: result.stdout.trim() };
  },
});

const listInterfaces = defineAction({
  id: 'wireguard.listInterfaces',
  category: 'wireguard',
  label: 'List WireGuard tunnels',
  mutating: false,
  paramsSchema: z.object({}),
  async detect() {
    const result = await runHelperScript('WIREGUARD_STATUS', ['list']);
    if (!result.success) return { interfaces: [] };
    const interfaces = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, up, listenPort, peerCount] = line.split('\t');
        return { name, up: up === '1', listenPort: listenPort ? Number(listenPort) : null, peerCount: Number(peerCount) || 0 };
      });
    return { interfaces };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
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
        // Arbitrary user-assigned label from a "# group: <name>" comment
        // (same convention as "# name:") — purely a display/clustering
        // hint for the network views, null when unset.
        group: parts[8] || null,
      });
    }
  }
  return status;
}

const interfaceOnlySchema = z.object({ interfaceName: interfaceNameSchema });

const status = defineAction({
  id: 'wireguard.status',
  category: 'wireguard',
  label: 'WireGuard interface + peer status',
  mutating: false,
  paramsSchema: interfaceOnlySchema,
  async detect(params) {
    const result = await runHelperScript('WIREGUARD_STATUS', ['show', params.interfaceName]);
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
  paramsSchema: interfaceOnlySchema,
  async detect(params) {
    const result = await runHelperScript('WIREGUARD_STATUS', ['show', params.interfaceName]);
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
  interfaceName: interfaceNameSchema,
  peerName: z.string().min(1).max(64).regex(peerNameToken),
  allowedIps: allowedIpsList,
  // Arbitrary user-assigned label written as a "# group: <name>" comment —
  // purely a clustering hint for the network views, WireGuard itself never
  // reads it.
  group: z.string().max(64).regex(peerNameToken).optional(),
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
    const result = await runHelperScript('WIREGUARD_STATUS', ['show', params.interfaceName]);
    const existing = result.success ? parseStatus(result.stdout).peers : [];
    return { exists: existing.some((p) => p.name === params.peerName) };
  },
  async plan(params, detectResult) {
    if (detectResult.exists) return { description: 'Already satisfied (peer exists)', changes: [] };
    return { description: `Add peer ${params.peerName} to ${params.interfaceName} with allowedIps ${params.allowedIps}` };
  },
  async apply(params, detectResult) {
    if (detectResult.exists) return { alreadySatisfied: true };
    const args = [params.interfaceName, params.peerName, params.allowedIps];
    if (params.group) args.push(params.group);
    const result = await runHelperScript('WIREGUARD_PEER_ADD', args);
    if (!result.success) {
      throw new Error(`wireguard_peer_add failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    const parsed = parsePeerAddOutput(result.stdout);
    // The client private key is returned exactly once here and never persisted server-side.
    return { alreadySatisfied: false, ...parsed };
  },
});

const peerUpdateSchema = z.object({
  interfaceName: interfaceNameSchema,
  peerName: z.string().min(1).max(64).regex(peerNameToken), // current name
  newPeerName: z.string().min(1).max(64).regex(peerNameToken),
  allowedIps: allowedIpsList,
  // Empty/omitted clears any existing group for this peer — the edit form
  // always submits the field's current value, so "blank" is a deliberate clear.
  group: z.string().max(64).regex(peerNameToken).optional(),
});

const peerUpdate = defineAction({
  id: 'wireguard.peerUpdate',
  category: 'wireguard',
  label: 'Edit a WireGuard peer',
  paramsSchema: peerUpdateSchema,
  async detect(params) {
    const result = await runHelperScript('WIREGUARD_STATUS', ['show', params.interfaceName]);
    const existing = result.success ? parseStatus(result.stdout).peers : [];
    return {
      exists: existing.some((p) => p.name === params.peerName),
      nameCollision: params.newPeerName !== params.peerName && existing.some((p) => p.name === params.newPeerName),
    };
  },
  async plan(params, detectResult) {
    if (!detectResult.exists) throw new Error(`No such peer: ${params.peerName}`);
    if (detectResult.nameCollision) throw new Error(`A peer named ${params.newPeerName} already exists`);
    return { description: `Update peer ${params.peerName} on ${params.interfaceName} (public key unchanged)` };
  },
  async apply(params, detectResult) {
    if (!detectResult.exists) throw new Error(`No such peer: ${params.peerName}`);
    if (detectResult.nameCollision) throw new Error(`A peer named ${params.newPeerName} already exists`);
    const args = [params.interfaceName, params.peerName, params.newPeerName, params.allowedIps];
    if (params.group) args.push(params.group);
    const result = await runHelperScript('WIREGUARD_PEER_UPDATE', args);
    if (!result.success) {
      throw new Error(`wireguard_peer_update failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { stdout: result.stdout.trim() };
  },
});

// Must match the sentinel literal in scripts/wireguard_config.sh exactly.
const PRIVATE_KEY_SENTINEL = '<REDACTED>';

function redactPrivateKey(content) {
  // Case-insensitive to match: WireGuard's own parser treats key names as
  // case-insensitive, and real-world configs on the target box mix
  // "PublicKey"/"publicKey" — a case-sensitive match here would silently
  // leak the real private key to the browser for any config not using the
  // exact canonical casing. Every match gets redacted (there should only
  // ever be one PrivateKey line, but never assume).
  return content.replace(/^[Pp]rivate[Kk]ey\s*=.*$/gm, `PrivateKey = ${PRIVATE_KEY_SENTINEL}`);
}

const getConfigRaw = defineAction({
  id: 'wireguard.getConfigRaw',
  category: 'wireguard',
  label: 'Get raw tunnel config (private key redacted)',
  mutating: false,
  paramsSchema: interfaceOnlySchema,
  async detect(params) {
    const result = await runHelperScript('WIREGUARD_CONFIG', ['get', params.interfaceName]);
    if (!result.success) return { exists: false, content: null };
    return { exists: true, content: redactPrivateKey(result.stdout) };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const setConfigRawSchema = z.object({ interfaceName: interfaceNameSchema, content: z.string().min(1).max(200_000) });

const setConfigRaw = defineAction({
  id: 'wireguard.setConfigRaw',
  category: 'wireguard',
  label: 'Edit raw tunnel config',
  paramsSchema: setConfigRawSchema,
  async detect(params) {
    const result = await runHelperScript('WIREGUARD_CONFIG', ['get', params.interfaceName]);
    return { exists: result.success };
  },
  async plan(params, detectResult) {
    if (!detectResult.exists) throw new Error(`${params.interfaceName}.conf does not exist; run wireguard.initInterface first`);
    return { description: `Overwrite ${params.interfaceName}.conf (validated with wg-quick strip before activating; live peers re-synced if the interface is up)` };
  },
  async apply(params) {
    // The client normally echoes back the redacted sentinel for an unrelated
    // edit; scripts/wireguard_config.sh splices the real key back in when it
    // sees that literal. Supplying a real key value instead genuinely rotates it.
    const result = await runHelperScript('WIREGUARD_CONFIG', ['setraw', params.interfaceName], { timeoutMs: 30_000, input: params.content });
    if (!result.success) {
      throw new Error(`wireguard_config setraw failed validation, rolled back (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    const getResult = await runHelperScript('WIREGUARD_CONFIG', ['get', params.interfaceName]);
    return { stdout: result.stdout.trim(), content: getResult.success ? redactPrivateKey(getResult.stdout) : null };
  },
});

const peerRemoveSchema = z.object({ interfaceName: interfaceNameSchema, peerName: z.string().min(1).max(64).regex(peerNameToken) });

const peerRemove = defineAction({
  id: 'wireguard.peerRemove',
  category: 'wireguard',
  label: 'Remove a WireGuard peer',
  paramsSchema: peerRemoveSchema,
  async detect(params) {
    const result = await runHelperScript('WIREGUARD_STATUS', ['show', params.interfaceName]);
    const existing = result.success ? parseStatus(result.stdout).peers : [];
    return { exists: existing.some((p) => p.name === params.peerName) };
  },
  async plan(params, detectResult) {
    if (!detectResult.exists) return { description: 'Already satisfied (no such peer)', changes: [] };
    return { description: `Remove peer ${params.peerName} from ${params.interfaceName}` };
  },
  async apply(params, detectResult) {
    if (!detectResult.exists) return { alreadySatisfied: true };
    const result = await runHelperScript('WIREGUARD_PEER_REMOVE', [params.interfaceName, params.peerName]);
    if (!result.success) {
      throw new Error(`wireguard_peer_remove failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { alreadySatisfied: false, stdout: result.stdout.trim() };
  },
});

async function checkConfigSyntax(interfaceName) {
  const result = await runHelperScript('WIREGUARD_CONFIG', ['test', interfaceName], { timeoutMs: 15_000 });
  return { valid: result.success, output: (result.stderr || result.stdout).trim() };
}

function summarizePeerStatuses(peers) {
  const counts = { good: 0, warning: 0, critical: 0 };
  for (const p of peers) {
    const age = p.latestHandshake ? Date.now() / 1000 - Number(p.latestHandshake) : Infinity;
    if (age <= 180) counts.good++;
    else if (age <= 600) counts.warning++;
    else counts.critical++;
  }
  return counts;
}

const checkTunnel = defineAction({
  id: 'wireguard.checkTunnel',
  category: 'wireguard',
  label: 'Run diagnostic checks for a WireGuard tunnel',
  mutating: false,
  paramsSchema: interfaceOnlySchema,
  async detect(params) {
    const [configSyntax, statusResult] = await Promise.all([
      tryHelperCheck(() => checkConfigSyntax(params.interfaceName), { valid: false }),
      runHelperScript('WIREGUARD_STATUS', ['show', params.interfaceName]).catch((err) => ({ success: false, stdout: '', stderr: err.message })),
    ]);

    const up = statusResult.success;
    const parsed = up ? parseStatus(statusResult.stdout) : { interface: null, peers: [] };
    const listenPort = parsed.interface ? Number(parsed.interface.listenPort) : null;

    const firewall = listenPort
      ? await tryHelperCheck(() => checkFirewallPort(listenPort, 'udp'), { port: listenPort, protocol: 'udp', ufwAllowed: false, listening: false })
      : null;

    return {
      exists: true,
      checkedAt: new Date().toISOString(),
      interfaceName: params.interfaceName,
      up,
      upError: up ? null : statusResult.stderr?.trim() || null,
      listenPort,
      publicKey: parsed.interface?.publicKey ?? null,
      peerCount: parsed.peers.length,
      peerStatusCounts: summarizePeerStatuses(parsed.peers),
      configSyntax,
      firewall,
    };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

export const wireguardActions = [
  detect,
  install,
  initInterface,
  listInterfaces,
  status,
  peerList,
  peerAdd,
  peerUpdate,
  peerRemove,
  getConfigRaw,
  setConfigRaw,
  checkTunnel,
];
