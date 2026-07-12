import { getAction } from '../catalog/index.js';
import { listRoutes, getRouteByConfigFileName } from '../db/nginxRoutes.js';
import { classifyDnsStatus, checkTcp, checkHttp } from './networkDiagnostics.js';
import { runHelperScript } from '../exec/sudoExec.js';

const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function validateHostnameFormat(hostname) {
  if (!hostname || typeof hostname !== 'string') return { valid: false, reason: 'Hostname is required' };
  if (hostname.includes('://')) return { valid: false, reason: 'Do not include a protocol (http:// etc.)' };
  if (hostname.includes('/')) return { valid: false, reason: 'Do not include a path' };
  if (/\s/.test(hostname)) return { valid: false, reason: 'Hostname cannot contain spaces' };
  if (!hostnameRegex.test(hostname)) return { valid: false, reason: 'Invalid hostname format' };
  return { valid: true };
}

// filename rules from the spec: no spaces, no "..", no "/", no backslashes,
// no shell metacharacters, not empty. This mirrors validate_site_name() in
// scripts/nginx_configure.sh — kept in sync deliberately since a name that
// passes here but fails there (or vice versa) would be a confusing UX bug.
const configFileNameRegex = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,120}[A-Za-z0-9])?$/;

export function generateConfigFileName(hostname) {
  return hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 122);
}

export function validateConfigFileName(name) {
  if (!name) return { valid: false, reason: 'Configuration file name is required' };
  if (name.includes('..')) return { valid: false, reason: 'Must not contain ".."' };
  if (name.includes('/') || name.includes('\\')) return { valid: false, reason: 'Must not contain a slash or backslash' };
  if (/\s/.test(name)) return { valid: false, reason: 'Must not contain spaces' };
  if (!configFileNameRegex.test(name)) return { valid: false, reason: 'Only letters, digits, dot, dash, underscore are allowed' };
  return { valid: true };
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Every hostname currently in play, from both sources of truth: the actual
// NGINX files (covers hand-written sites this tool didn't create) and the
// route DB (covers drafts not yet deployed to a file at all). Reading the
// filesystem side goes through sudo-scoped helper scripts, whose spawn-level
// failures throw rather than degrade — deliberately not caught here, since
// duplicate-detection silently missing a real conflict would be worse than
// this whole check failing loudly. The caller (checkDuplicateHostname) is
// what decides how to degrade for the "run several checks together" case.
export async function getAllKnownServerNames() {
  const listSites = getAction('nginx.listSites');
  const getRaw = getAction('nginx.getSiteRaw');
  const { sites } = await listSites.detect({});
  const names = new Set();
  for (const site of sites) {
    const { content } = await getRaw.detect({ name: site.name });
    if (!content) continue;
    for (const m of content.matchAll(/^\s*server_name\s+([^;]+);/gm)) {
      for (const n of m[1].trim().split(/\s+/)) names.add(n);
    }
  }
  for (const route of listRoutes()) names.add(route.public_hostname);
  return [...names];
}

export async function checkDuplicateHostname(hostname) {
  try {
    const known = await getAllKnownServerNames();
    const duplicate = known.includes(hostname);
    const nearMatches = known.filter((n) => n !== hostname && levenshtein(n.toLowerCase(), hostname.toLowerCase()) <= 2);
    return { duplicate, nearMatches, checkError: null };
  } catch (err) {
    // Combined with several other checks in a single Promise.all — this one
    // failing (e.g. the underlying sudo call breaking) must not take every
    // other check's result down with it. Surfaced as checkError so the UI
    // can show "couldn't verify" rather than silently claiming "available".
    return { duplicate: false, nearMatches: [], checkError: err.message };
  }
}

export function checkDuplicateConfigFileName(name) {
  return { duplicate: !!getRouteByConfigFileName(name) };
}

export const checkDns = classifyDnsStatus;

export async function checkBackendReachability({ protocol, host, port, path }) {
  const tcp = await checkTcp(host, port);
  let http = null;
  if (tcp.reachable) {
    const p = path && path.startsWith('/') ? path : `/${path || ''}`;
    http = await checkHttp(`${protocol}://${host}:${port}${p}`);
  }
  return { tcp, http };
}

// A spawn-level failure (missing sudo binary, helper script unreadable,
// etc.) throws from runHelperScript rather than resolving with
// success:false — that's the right behavior for a mutating action, where
// the caller needs to know the difference between "ran and failed" and
// "never ran at all". But a *read-only, best-effort* validation check like
// this one is combined with several others in a single Promise.all — one
// hard throw there must not take down every other check's result along
// with it, so failures are caught and turned into a graceful "couldn't
// determine" state instead of propagating.
async function tryRunHelper(key, args) {
  try {
    return await runHelperScript(key, args);
  } catch (err) {
    return { success: false, stdout: '', stderr: err.message };
  }
}

export async function checkFirewallPort(port) {
  const [ufwResult, listenResult] = await Promise.all([
    tryRunHelper('UFW_RULE', ['status']),
    tryRunHelper('PORT_CHECK', [String(port)]),
  ]);
  const ufwAllowed = ufwResult.success && new RegExp(`(^|\\s)${port}(/tcp)?\\s+ALLOW`, 'im').test(ufwResult.stdout);
  const listening = listenResult.success && listenResult.stdout.trim().length > 0;
  return {
    port,
    ufwAllowed,
    listening,
    listenInfo: listening ? listenResult.stdout.trim() : null,
    ufwStatusRaw: ufwResult.success ? ufwResult.stdout.trim() : null,
    checkError: !ufwResult.success && !listenResult.success ? (ufwResult.stderr || listenResult.stderr) : null,
  };
}

/**
 * Runs every Phase 4/5-style check for a candidate route in one pass. Pure
 * validation — no side effects, safe to call repeatedly as the wizard form
 * changes.
 */
export async function validateRouteCandidate({ hostname, configFileName, backendProtocol, backendHost, backendPort, backendBasePath }) {
  const hostnameFormat = validateHostnameFormat(hostname);
  const fileNameFormat = validateConfigFileName(configFileName);

  const [duplicateHostname, duplicateFile, dns, firewall80, firewall443, backend] = await Promise.all([
    hostnameFormat.valid ? checkDuplicateHostname(hostname) : Promise.resolve({ duplicate: false, nearMatches: [] }),
    fileNameFormat.valid ? Promise.resolve(checkDuplicateConfigFileName(configFileName)) : Promise.resolve({ duplicate: false }),
    hostnameFormat.valid ? classifyDnsStatus(hostname) : Promise.resolve(null),
    checkFirewallPort(80),
    checkFirewallPort(443),
    backendHost && backendPort
      ? checkBackendReachability({ protocol: backendProtocol || 'http', host: backendHost, port: backendPort, path: backendBasePath || '/' })
      : Promise.resolve(null),
  ]);

  return {
    hostname: { ...hostnameFormat, ...duplicateHostname },
    configFileName: { ...fileNameFormat, ...duplicateFile },
    dns,
    firewall: { port80: firewall80, port443: firewall443 },
    backend,
  };
}
