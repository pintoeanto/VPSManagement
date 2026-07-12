// Best-effort extraction from a raw NGINX server block — enough to drive
// read-only diagnostics (DNS, backend reachability, cert status) against a
// site regardless of whether this tool created it (hand-written vhosts are
// parsed identically to tool-generated ones). Not a full NGINX config parser
// — only the handful of directives the checks actually need.

export function parseSiteConfig(content) {
  const hostnames = [];
  for (const m of content.matchAll(/^\s*server_name\s+([^;]+);/gm)) {
    for (const n of m[1].trim().split(/\s+/)) {
      if (n !== '_' && !hostnames.includes(n)) hostnames.push(n);
    }
  }

  const listens = [];
  for (const m of content.matchAll(/^\s*listen\s+([^;]+);/gm)) {
    const parts = m[1].trim().split(/\s+/);
    const portToken = parts.find((p) => /^\d+$/.test(p) || /:\d+$/.test(p));
    const port = portToken ? Number(portToken.split(':').pop()) : null;
    listens.push({ port, ssl: parts.includes('ssl') });
  }

  const proxyTargets = [];
  for (const m of content.matchAll(/proxy_pass\s+(https?):\/\/([^:/\s]+)(?::(\d+))?([^;\s]*)\s*;/g)) {
    const protocol = m[1];
    proxyTargets.push({
      protocol,
      host: m[2],
      port: m[3] ? Number(m[3]) : protocol === 'https' ? 443 : 80,
      path: m[4] || '/',
    });
  }

  return {
    hostnames,
    listens,
    proxyTargets,
    hasSsl: listens.some((l) => l.ssl),
    ignoreBackendTlsErrors: /proxy_ssl_verify\s+off/i.test(content),
  };
}
