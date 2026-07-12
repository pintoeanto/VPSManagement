import dns from 'node:dns/promises';
import net from 'node:net';

// Pure network diagnostics — no shell-out, no sudo. DNS resolution, TCP
// connect, and HTTP fetch are all things any unprivileged process can do
// directly via Node's built-ins, so there's no reason to route them through
// the sudo-scoped helper-script path used for actual system mutation.

export async function resolveHostname(hostname) {
  try {
    const addresses = await dns.resolve4(hostname);
    return { resolved: true, addresses };
  } catch {
    // Any resolution failure (not found, no data, timeout, server failure,
    // ...) is equally "can't confirm DNS is set up" from the caller's
    // point of view — never throw out of a best-effort validation check.
    return { resolved: false, addresses: [] };
  }
}

export async function getPublicIp() {
  // Best-effort: ask a couple of independent echo services, short timeout,
  // never throws — DNS validation degrades to "unknown" rather than failing
  // the whole check if outbound access to these happens to be blocked.
  const endpoints = ['https://api.ipify.org', 'https://ifconfig.me/ip'];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (net.isIPv4(text)) return text;
    } catch {
      // try next endpoint
    }
  }
  return null;
}

// Shared DNS-vs-public-IP classification, used by both the standalone
// nginx.testHostname catalog action and the route validation service so
// they can never disagree about what "passed" means.
export async function classifyDnsStatus(hostname) {
  const [dnsResult, publicIp] = await Promise.all([resolveHostname(hostname), getPublicIp()]);
  let status;
  if (!dnsResult.resolved) status = 'missing';
  else if (!publicIp) status = 'unknown';
  else if (dnsResult.addresses.length > 1) status = 'multiple_records';
  else if (dnsResult.addresses[0] === publicIp) status = 'passed';
  else status = 'points_elsewhere';
  return { resolvedAddresses: dnsResult.addresses, vpsPublicIp: publicIp, status };
}

export function checkTcp(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.connect({ host, port, timeout: timeoutMs });
    const finish = (reachable, error) => {
      socket.destroy();
      resolve({ reachable, responseTimeMs: Date.now() - start, error: error ?? null });
    };
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timed out'));
    socket.once('error', (err) => finish(false, err.message));
  });
}

export async function checkHttp(url, { timeoutMs = 5000, insecureTls = false } = {}) {
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      // Node's fetch (undici) honors NODE_TLS_REJECT_UNAUTHORIZED globally,
      // not per-request; per-request TLS relaxation isn't exposed here, so
      // "ignore backend TLS errors" is handled by the caller choosing not to
      // use https in the check when that option is set, rather than by
      // actually disabling cert validation for this specific request.
    });
    void insecureTls;
    return {
      reachable: true,
      httpStatus: res.status,
      responseTimeMs: Date.now() - start,
      error: null,
    };
  } catch (err) {
    return {
      reachable: false,
      httpStatus: null,
      responseTimeMs: Date.now() - start,
      error: err.name === 'TimeoutError' ? 'timed out' : err.message,
    };
  }
}
