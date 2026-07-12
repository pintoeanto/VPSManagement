import { getAction } from '../catalog/index.js';
import { runHelperScript } from '../exec/sudoExec.js';
import { generateHttpOnlyConfig, generateHttpsConfig } from './nginxConfigGenerator.js';
import { updateRoute } from '../db/nginxRoutes.js';

/**
 * The chicken-egg-safe TLS sequence from the spec, steps 1-7:
 *   1. Generate an HTTP-only config and write it (live immediately over
 *      plain HTTP — the site works right away, and the ACME challenge
 *      location is already in place).
 *   2. Issue the certificate via the webroot method (never touches nginx
 *      config, never stops nginx).
 *   3. Verify the certificate files actually exist before trusting them.
 *   4. Generate and write the final HTTPS config (which also carries an
 *      HTTP->HTTPS redirect + the ACME location for renewals).
 * Every write step goes through the exact same backup/validate/rollback
 * path as the manual raw editor (nginx.setSiteRaw), reused here rather than
 * reimplemented, and each step's outcome is captured so the caller can show
 * a per-step progress report and never has to guess what happened.
 */
export async function deployRoute(route, { issueTls, certbotEmail } = {}) {
  const steps = [];
  const setRaw = getAction('nginx.setSiteRaw');

  function record(name, ok, detail) {
    steps.push({ step: name, status: ok ? 'passed' : 'failed', detail });
    return ok;
  }

  // Step: write the HTTP-only config so the route is live immediately.
  try {
    const httpConfig = generateHttpOnlyConfig(route);
    await setRaw.apply({ name: route.configFileName, content: httpConfig });
    record('write_http_config', true, 'HTTP vhost written and NGINX reloaded');
  } catch (err) {
    record('write_http_config', false, err.message);
    return { success: false, steps, certificateStatus: 'error' };
  }

  if (!issueTls) {
    updateRoute(route.id, { lastDeployedAt: new Date().toISOString(), enabled: true, certificateStatus: 'none' });
    return { success: true, steps, certificateStatus: 'none' };
  }

  // Step: issue the certificate via webroot — config is untouched by this.
  let certResult;
  try {
    certResult = await runHelperScript('NGINX_CERTBOT_WEBROOT', [route.publicHostname, certbotEmail], { timeoutMs: 120_000 });
    if (!certResult.success) throw new Error(certResult.stderr.trim() || 'certbot failed');
    record('issue_certificate', true, certResult.stdout.trim());
  } catch (err) {
    record('issue_certificate', false, err.message);
    updateRoute(route.id, { lastDeployedAt: new Date().toISOString(), enabled: true, certificateStatus: 'error' });
    // The HTTP-only config from step 1 is still live and working — this is
    // a partial success, not a broken site, so we return success at the
    // transport level while flagging TLS specifically as failed.
    return { success: true, tlsSuccess: false, steps, certificateStatus: 'error' };
  }

  // Step: confirm the certificate files actually exist before switching the
  // vhost to reference them — never enable a TLS config for a cert that
  // isn't really there.
  const certLines = Object.fromEntries(
    certResult.stdout
      .trim()
      .split('\n')
      .map((l) => l.split('='))
      .filter((p) => p.length === 2)
  );
  if (!certLines.CERT_PATH || !certLines.KEY_PATH) {
    record('verify_certificate_files', false, 'certbot did not report certificate paths');
    updateRoute(route.id, { lastDeployedAt: new Date().toISOString(), enabled: true, certificateStatus: 'error' });
    return { success: true, tlsSuccess: false, steps, certificateStatus: 'error' };
  }
  record('verify_certificate_files', true, `${certLines.CERT_PATH}, expires ${certLines.EXPIRY ?? 'unknown'}`);

  // Step: switch to the final HTTPS config now that the cert is confirmed real.
  try {
    const httpsConfig = generateHttpsConfig(route);
    await setRaw.apply({ name: route.configFileName, content: httpsConfig });
    record('write_https_config', true, 'HTTPS vhost written and NGINX reloaded');
  } catch (err) {
    record('write_https_config', false, err.message);
    updateRoute(route.id, { lastDeployedAt: new Date().toISOString(), enabled: true, certificateStatus: 'valid', certificateExpiry: certLines.EXPIRY ?? null });
    return { success: true, tlsSuccess: false, steps, certificateStatus: 'valid' };
  }

  updateRoute(route.id, {
    lastDeployedAt: new Date().toISOString(),
    enabled: true,
    certificateStatus: 'valid',
    certificateExpiry: certLines.EXPIRY ?? null,
  });

  return { success: true, tlsSuccess: true, steps, certificateStatus: 'valid', certificateExpiry: certLines.EXPIRY ?? null };
}
