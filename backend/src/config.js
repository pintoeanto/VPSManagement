import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(6000),
  DB_PATH: z.string().default('./data/vps-console.db'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  TOTP_ENC_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'TOTP_ENC_KEY must be exactly 32 bytes as hex (64 hex chars)'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('7d'),
  COOKIE_SECURE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  JAIL_ROOT: z.string().default('./data/jail'),
  HELPER_SCRIPTS_DIR: z.string().default('./scripts'),
  ALLOWED_SERVICE_UNITS: z
    .string()
    .default('nginx,mosquitto,wg-quick@wg0,ssh')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  DEV_CORS_ORIGIN: z.string().optional(),
});

function loadConfig() {
  // In test/dev, allow a fallback so the app can boot without a real .env for quick checks.
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    throw new Error('Environment validation failed. See backend/.env.example.');
  }
  const env = parsed.data;
  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    dbPath: path.resolve(repoRoot, env.DB_PATH),
    jailRoot: path.resolve(repoRoot, env.JAIL_ROOT),
    helperScriptsDir: path.resolve(repoRoot, env.HELPER_SCRIPTS_DIR),
    repoRoot,
  };
}

export const config = loadConfig();
