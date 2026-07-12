import helmet from 'helmet';
import { config } from '../config.js';

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
    },
    hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  });
}

/**
 * Refuses to serve any /api route over plaintext in production when a
 * reverse proxy explicitly says the original request was plaintext. NGINX
 * (deploy/nginx/vps-console.conf) always sets X-Forwarded-Proto, so a real
 * public request misconfigured to skip TLS is still caught here. A request
 * with NO forwarding header at all reached us directly on the loopback-only
 * bind (HOST=127.0.0.1) — e.g. through an SSH tunnel for local dev against a
 * live VPS, or from the VPS itself — which is already gated by network
 * topology (an SSH tunnel is its own encrypted transport) rather than by
 * this header, so it's not rejected here.
 */
export function requireTls(req, res, next) {
  if (!config.isProduction) return next();
  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto !== 'https') {
    return res.status(403).json({ error: 'HTTPS required' });
  }
  next();
}
