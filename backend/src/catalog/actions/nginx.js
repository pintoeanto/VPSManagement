import { z } from 'zod';
import { defineAction } from '../types.js';
import { execReadOnly, runHelperScript } from '../../exec/sudoExec.js';

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

export const nginxActions = [detect, install, listSites, configureSite, removeSite, getSiteRaw, setSiteRaw, certbotIssue];
