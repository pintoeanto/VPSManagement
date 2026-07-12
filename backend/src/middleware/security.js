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
 * Refuses to serve any /api route over plaintext in production. We sit behind
 * an NGINX TLS proxy (or an SSH/WireGuard tunnel to a TLS-terminating proxy),
 * which sets X-Forwarded-Proto; trust it only because app.set('trust proxy', ...)
 * is scoped to loopback in server.js.
 */
export function requireTls(req, res, next) {
  if (!config.isProduction) return next();
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  if (proto !== 'https') {
    return res.status(403).json({ error: 'HTTPS required' });
  }
  next();
}
