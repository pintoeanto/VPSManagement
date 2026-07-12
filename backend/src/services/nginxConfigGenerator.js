// Structured NGINX config generator for the route configurator. Deliberately
// not a sed-templated file like the older static/proxy quick-create path —
// this needs real conditional logic (websocket headers only when enabled,
// no proxy_ssl_* for HTTP backends, TLS block only once a cert exists),
// which is far more readable and testable as plain JS string-building than
// as a shell template.

const ACME_CHALLENGE_LOCATION = `    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
        default_type "text/plain";
    }
`;

function normalizeBasePath(basePath) {
  let p = basePath || '/';
  if (!p.startsWith('/')) p = `/${p}`;
  if (!p.endsWith('/')) p = `${p}/`;
  return p;
}

function proxyPassTarget(route) {
  const base = route.preserveIncomingPath === false ? '' : normalizeBasePath(route.backendBasePath);
  return `${route.backendProtocol}://${route.backendHost}:${route.backendPort}${base}`;
}

function proxyCommonDirectives(route, { https }) {
  const lines = [
    `        proxy_pass ${proxyPassTarget(route)};`,
    '',
    '        proxy_http_version 1.1;',
    '',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Forwarded-Host $host;',
    `        proxy_set_header X-Forwarded-Proto ${https ? 'https' : '$scheme'};`,
  ];
  if (https) {
    lines.push('        proxy_set_header X-Forwarded-Scheme https;', '        proxy_set_header X-Forwarded-Ssl on;', '        proxy_set_header X-Forwarded-Port 443;');
  }
  lines.push(
    '',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  );
  if (route.websocketEnabled) {
    lines.push('', '        proxy_set_header Upgrade $http_upgrade;', '        proxy_set_header Connection "upgrade";');
  }
  if (route.backendProtocol === 'https' && route.ignoreBackendTlsErrors) {
    lines.push('', '        proxy_ssl_verify off;', '        proxy_ssl_server_name on;');
  }
  lines.push(
    '',
    `        proxy_connect_timeout ${route.connectTimeoutSeconds ?? 10};`,
    `        proxy_read_timeout ${route.readTimeoutSeconds ?? 60};`,
    `        proxy_send_timeout ${route.sendTimeoutSeconds ?? 60};`,
    '',
    '        proxy_intercept_errors on;'
  );
  return lines.join('\n');
}

/**
 * Phase-1 config: plain HTTP, proxies live traffic immediately (the site
 * works right away, before any certificate exists) and always carries the
 * ACME challenge location so a webroot cert issuance can run against it
 * without ever needing to stop NGINX. Safe to leave in place indefinitely
 * for routes that don't want TLS at all.
 */
export function generateHttpOnlyConfig(route) {
  return `server {
    listen 80;
    listen [::]:80;
    server_name ${route.publicHostname};

    client_max_body_size 100m;

${ACME_CHALLENGE_LOCATION}
    error_page 502 503 504 = /service-unavailable.html;
    location = /service-unavailable.html {
        root /var/www/vps-console-errors;
        internal;
    }

    location / {
${proxyCommonDirectives(route, { https: false })}
    }
}
`;
}

/**
 * Phase-2 config: full HTTPS vhost plus an HTTP vhost that redirects to it
 * (still carrying the ACME challenge location so renewals keep working
 * without needing to fall back to phase 1). Only ever generated after the
 * certificate files are confirmed to exist — see nginxRouteDeployer.js.
 */
export function generateHttpsConfig(route) {
  const host = route.publicHostname;
  return `server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${host};

    ssl_certificate /etc/letsencrypt/live/${host}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${host}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 100m;

    error_page 502 503 504 = /service-unavailable.html;
    location = /service-unavailable.html {
        root /var/www/vps-console-errors;
        internal;
    }

    location / {
${proxyCommonDirectives(route, { https: true })}
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name ${host};

${ACME_CHALLENGE_LOCATION}
    location / {
        return 301 https://$host$request_uri;
    }
}
`;
}
