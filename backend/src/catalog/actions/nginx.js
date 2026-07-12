import { z } from 'zod';
import { defineAction } from '../types.js';
import { execReadOnly, runHelperScript } from '../../exec/sudoExec.js';
import { classifyDnsStatus, checkTcp, checkHttp } from '../../services/networkDiagnostics.js';
import { checkFirewallPort } from '../../services/firewallCheck.js';
import { parseSiteConfig } from '../../services/nginxSiteParser.js';
import { tryHelperCheck } from '../../services/tryHelperCheck.js';

const hostnameToken = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
// Broader than hostnameToken: matches the literal filename under
// sites-available, which includes both hostnames created through this tool
// and arbitrary pre-existing hand-written vhost filenames (e.g.
// "cupo-route-alfattan", no ".conf" suffix). Must mirror
// validate_site_name() in scripts/nginx_configure.sh exactly.
const siteNameToken = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,120}[A-Za-z0-9])?$/;

async function detectNginx() {
  const [dpkg, version] = await Promise.all([
    execReadOnly('dpkg-query', ['-W', '-f=${Status} ${Version}', 'nginx']),
    execReadOnly('nginx', ['-v']),
  ]);
  const installed = dpkg.success && dpkg.stdout.includes('install ok installed');
  return {
    installed,
    version: installed ? (version.stderr || version.stdout).trim() : null,
  };
}

const detect = defineAction({
  id: 'nginx.detect',
  category: 'nginx',
  label: 'Detect NGINX install state',
  mutating: false,
  paramsSchema: z.object({}),
  detect: detectNginx,
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const install = defineAction({
  id: 'nginx.install',
  category: 'nginx',
  label: 'Install NGINX',
  paramsSchema: z.object({}),
  detect: detectNginx,
  async plan(_params, detectResult) {
    if (detectResult.installed) {
      return { description: 'Already satisfied', changes: [] };
    }
    return { description: 'Install nginx via apt', changes: ['apt-get install -y nginx'] };
  },
  async apply(_params, detectResult) {
    if (detectResult.installed) {
      return { alreadySatisfied: true, ...detectResult };
    }
    const result = await runHelperScript('NGINX_INSTALL', [], { timeoutMs: 120_000 });
    if (!result.success) {
      throw new Error(`nginx_install failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { alreadySatisfied: false, ...(await detectNginx()) };
  },
});

const listSites = defineAction({
  id: 'nginx.listSites',
  category: 'nginx',
  label: 'List NGINX server blocks',
  mutating: false,
  paramsSchema: z.object({}),
  async detect() {
    const result = await runHelperScript('NGINX_CONFIGURE', ['list']);
    if (!result.success) return { sites: [], error: result.stderr.trim() };
    const sites = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, enabled] = line.split('\t');
        return { name, enabled: enabled === '1' };
      });
    return { sites };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const configureSiteSchema = z
  .object({
    serverName: z.string().max(253).regex(hostnameToken, 'Invalid hostname'),
    mode: z.enum(['static', 'proxy']),
    listenPort: z.coerce.number().int().min(1).max(65535).default(80),
    proxyPass: z.string().url().optional(),
  })
  .refine((v) => v.mode !== 'proxy' || !!v.proxyPass, {
    message: 'proxyPass is required when mode is "proxy"',
    path: ['proxyPass'],
  });

async function getSiteConfig(serverName) {
  const result = await runHelperScript('NGINX_CONFIGURE', ['get', serverName]);
  return result.success ? result.stdout : null;
}

const configureSite = defineAction({
  id: 'nginx.configureSite',
  category: 'nginx',
  label: 'Create or update an NGINX server block',
  paramsSchema: configureSiteSchema,
  async detect(params) {
    const existing = await getSiteConfig(params.serverName);
    return { exists: existing !== null, currentConfig: existing };
  },
  async plan(params, detectResult) {
    return {
      description: detectResult.exists
        ? `Update server block for ${params.serverName}`
        : `Create server block for ${params.serverName}`,
      mode: params.mode,
      listenPort: params.listenPort,
    };
  },
  async apply(params) {
    const args = ['apply', params.serverName, params.mode, String(params.listenPort)];
    if (params.mode === 'proxy') args.push(params.proxyPass);
    const result = await runHelperScript('NGINX_CONFIGURE', args, { timeoutMs: 30_000 });
    if (!result.success) {
      throw new Error(`nginx_configure failed validation, rolled back (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { stdout: result.stdout.trim(), config: await getSiteConfig(params.serverName) };
  },
});

const removeSiteSchema = z.object({ serverName: z.string().min(1).max(122).regex(siteNameToken) });

const removeSite = defineAction({
  id: 'nginx.removeSite',
  category: 'nginx',
  label: 'Disable an NGINX server block',
  paramsSchema: removeSiteSchema,
  async detect(params) {
    const existing = await getSiteConfig(params.serverName);
    return { exists: existing !== null };
  },
  async plan(params, detectResult) {
    if (!detectResult.exists) return { description: 'Already satisfied (no such site)', changes: [] };
    return { description: `Disable server block for ${params.serverName}` };
  },
  async apply(params, detectResult) {
    if (!detectResult.exists) return { alreadySatisfied: true };
    const result = await runHelperScript('NGINX_CONFIGURE', ['remove', params.serverName]);
    if (!result.success) {
      throw new Error(`nginx_configure remove failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { alreadySatisfied: false, stdout: result.stdout.trim() };
  },
});

const getSiteRawSchema = z.object({ name: z.string().min(1).max(122).regex(siteNameToken) });

const getSiteRaw = defineAction({
  id: 'nginx.getSiteRaw',
  category: 'nginx',
  label: 'Get raw NGINX site config',
  mutating: false,
  paramsSchema: getSiteRawSchema,
  async detect(params) {
    const content = await getSiteConfig(params.name);
    return { exists: content !== null, content };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const setSiteRawSchema = z.object({
  name: z.string().min(1).max(122).regex(siteNameToken),
  content: z.string().min(1).max(200_000),
});

const setSiteRaw = defineAction({
  id: 'nginx.setSiteRaw',
  category: 'nginx',
  label: 'Edit raw NGINX site config',
  paramsSchema: setSiteRawSchema,
  async detect(params) {
    const content = await getSiteConfig(params.name);
    return { exists: content !== null, currentContent: content };
  },
  async plan(params, detectResult) {
    return {
      description: detectResult.exists ? `Overwrite raw config for ${params.name}` : `Create raw config for ${params.name}`,
    };
  },
  async apply(params) {
    const result = await runHelperScript('NGINX_CONFIGURE', ['setraw', params.name], {
      timeoutMs: 30_000,
      input: params.content,
    });
    if (!result.success) {
      throw new Error(`nginx_configure setraw failed validation, rolled back (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { stdout: result.stdout.trim(), config: await getSiteConfig(params.name) };
  },
});

const listBackupsSchema = z.object({ name: z.string().min(1).max(122).regex(siteNameToken) });

const listBackups = defineAction({
  id: 'nginx.listBackups',
  category: 'nginx',
  label: 'List config backups for a site',
  mutating: false,
  paramsSchema: listBackupsSchema,
  async detect(params) {
    const result = await runHelperScript('NGINX_CONFIGURE', ['listbackups', params.name]);
    const backups = result.success ? result.stdout.trim().split('\n').filter(Boolean) : [];
    return { backups };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const getBackupSchema = z.object({
  name: z.string().min(1).max(122).regex(siteNameToken),
  backupFilename: z.string().min(1).max(200),
});

const getBackup = defineAction({
  id: 'nginx.getBackup',
  category: 'nginx',
  label: 'Get a config backup file content',
  mutating: false,
  paramsSchema: getBackupSchema,
  async detect(params) {
    const result = await runHelperScript('NGINX_CONFIGURE', ['getbackup', params.name, params.backupFilename]);
    return { exists: result.success, content: result.success ? result.stdout : null };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const restoreBackupSchema = z.object({
  name: z.string().min(1).max(122).regex(siteNameToken),
  backupFilename: z.string().min(1).max(200),
});

const restoreBackup = defineAction({
  id: 'nginx.restoreBackup',
  category: 'nginx',
  label: 'Restore a site config from a backup',
  paramsSchema: restoreBackupSchema,
  async detect(params) {
    const result = await runHelperScript('NGINX_CONFIGURE', ['getbackup', params.name, params.backupFilename]);
    return { backupExists: result.success };
  },
  async plan(params, detectResult) {
    if (!detectResult.backupExists) throw new Error(`Backup not found: ${params.backupFilename}`);
    return { description: `Restore ${params.name} from ${params.backupFilename} (current live config is itself backed up first)` };
  },
  async apply(params) {
    const result = await runHelperScript('NGINX_CONFIGURE', ['restore', params.name, params.backupFilename], { timeoutMs: 30_000 });
    if (!result.success) {
      throw new Error(`nginx_configure restore failed, rolled back (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { stdout: result.stdout.trim(), config: await getSiteConfig(params.name) };
  },
});

const testHostnameSchema = z.object({ hostname: z.string().max(253).regex(hostnameToken) });

const testHostname = defineAction({
  id: 'nginx.testHostname',
  category: 'nginx',
  label: 'Check DNS resolution against this VPS’s public IP',
  mutating: false,
  paramsSchema: testHostnameSchema,
  async detect(params) {
    return classifyDnsStatus(params.hostname);
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const testBackendSchema = z.object({
  protocol: z.enum(['http', 'https']).default('http'),
  host: z.string().min(1).max(253),
  port: z.coerce.number().int().min(1).max(65535),
  path: z.string().max(500).default('/'),
  ignoreTlsErrors: z.boolean().default(false),
});

const testBackend = defineAction({
  id: 'nginx.testBackend',
  category: 'nginx',
  label: 'Test backend TCP + HTTP reachability',
  mutating: false,
  paramsSchema: testBackendSchema,
  async detect(params) {
    const tcp = await checkTcp(params.host, params.port);
    let http = null;
    if (tcp.reachable) {
      const url = `${params.protocol}://${params.host}:${params.port}${params.path.startsWith('/') ? params.path : `/${params.path}`}`;
      http = await checkHttp(url, { insecureTls: params.ignoreTlsErrors });
    }
    return { tcp, http };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const listAllBackups = defineAction({
  id: 'nginx.listAllBackups',
  category: 'nginx',
  label: 'List NGINX config backups across all sites',
  mutating: false,
  paramsSchema: z.object({}),
  async detect() {
    const result = await runHelperScript('NGINX_CONFIGURE', ['listallbackups']);
    if (!result.success) return { backups: [], error: result.stderr.trim() };
    const backups = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, backupFilename] = line.split('\t');
        const m = backupFilename.match(/\.bak\.(\d{8}T\d{6}Z)$/);
        return { name, backupFilename, timestamp: m ? m[1] : null };
      })
      .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
    return { backups };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

async function checkConfigSyntax() {
  const result = await runHelperScript('NGINX_CONFIGURE', ['test'], { timeoutMs: 15_000 });
  return { valid: result.success, output: (result.stderr || result.stdout).trim() };
}

async function checkCertStatus(name) {
  const result = await runHelperScript('NGINX_CONFIGURE', ['certstatus', name]);
  if (!result.success) return { status: 'error', error: result.stderr.trim() };
  const line = result.stdout.trim();
  if (line === 'none' || line === 'missing' || line === 'unreadable') return { status: line };
  const [status, certPath, expiry] = line.split('\t');
  if (status !== 'valid') return { status: 'unknown', raw: line };
  const expiryMs = Date.parse(expiry);
  const daysRemaining = Number.isNaN(expiryMs) ? null : Math.floor((expiryMs - Date.now()) / 86_400_000);
  return { status: 'valid', certPath, expiry, daysRemaining };
}

const checkSiteSchema = z.object({ name: z.string().min(1).max(122).regex(siteNameToken) });

const checkSite = defineAction({
  id: 'nginx.checkSite',
  category: 'nginx',
  label: 'Run diagnostic checks for an NGINX site',
  mutating: false,
  paramsSchema: checkSiteSchema,
  async detect(params) {
    const content = await getSiteConfig(params.name);
    if (content === null) return { exists: false };

    const parsed = parseSiteConfig(content);
    const primaryHostname = parsed.hostnames[0] ?? null;
    const primaryTarget = parsed.proxyTargets[0] ?? null;
    const publicPort = parsed.hasSsl ? 443 : parsed.listens.find((l) => l.port)?.port ?? 80;
    const publicProtocol = parsed.hasSsl ? 'https' : 'http';

    const [configSyntax, dns, backend, firewall80, firewall443, certificate, publicHttp] = await Promise.all([
      tryHelperCheck(checkConfigSyntax, { valid: false }),
      primaryHostname ? classifyDnsStatus(primaryHostname) : Promise.resolve(null),
      primaryTarget
        ? (async () => {
            const tcp = await checkTcp(primaryTarget.host, primaryTarget.port);
            const http = tcp.reachable
              ? await checkHttp(`${primaryTarget.protocol}://${primaryTarget.host}:${primaryTarget.port}${primaryTarget.path}`, {
                  insecureTls: parsed.ignoreBackendTlsErrors,
                })
              : null;
            return { tcp, http };
          })()
        : Promise.resolve(null),
      parsed.listens.some((l) => l.port === 80) ? checkFirewallPort(80) : Promise.resolve(null),
      parsed.listens.some((l) => l.port === 443) ? checkFirewallPort(443) : Promise.resolve(null),
      parsed.hasSsl ? tryHelperCheck(() => checkCertStatus(params.name), { status: 'error' }) : Promise.resolve(null),
      // End-to-end check through NGINX itself (not the backend directly) —
      // catches proxy_pass/502 misconfigurations that a backend-only check
      // would miss. Attempted even if DNS doesn't currently point here,
      // since the site may still be reachable via other means (tunnel, hosts
      // file) worth confirming.
      primaryHostname ? checkHttp(`${publicProtocol}://${primaryHostname}:${publicPort}/`, { insecureTls: true }) : Promise.resolve(null),
    ]);

    return {
      exists: true,
      checkedAt: new Date().toISOString(),
      hostnames: parsed.hostnames,
      primaryHostname,
      hasSsl: parsed.hasSsl,
      configSyntax,
      dns,
      backend,
      firewall: { port80: firewall80, port443: firewall443 },
      certificate,
      publicHttp,
    };
  },
  async plan() {
    return { changes: [] };
  },
  async apply(_params, detectResult) {
    return detectResult;
  },
});

const certbotSchema = z.object({
  serverName: z.string().max(253).regex(hostnameToken),
  email: z.string().email(),
});

const certbotIssue = defineAction({
  id: 'nginx.certbotIssue',
  category: 'nginx',
  label: "Issue/renew a Let's Encrypt certificate for a server block",
  paramsSchema: certbotSchema,
  async detect(params) {
    const existing = await getSiteConfig(params.serverName);
    return { siteConfigured: existing !== null };
  },
  async plan(params, detectResult) {
    if (!detectResult.siteConfigured) {
      throw new Error(`No server block for ${params.serverName}; run nginx.configureSite first`);
    }
    return { description: `certbot --nginx -d ${params.serverName}` };
  },
  async apply(params) {
    const result = await runHelperScript('NGINX_CERTBOT', [params.serverName, params.email], { timeoutMs: 120_000 });
    if (!result.success) {
      throw new Error(`nginx_certbot failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    return { stdout: result.stdout.trim() };
  },
});

export const nginxActions = [
  detect,
  install,
  listSites,
  configureSite,
  removeSite,
  getSiteRaw,
  setSiteRaw,
  listBackups,
  listAllBackups,
  getBackup,
  restoreBackup,
  testHostname,
  testBackend,
  checkSite,
  certbotIssue,
];
