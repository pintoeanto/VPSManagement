import crypto from 'node:crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import argon2 from 'argon2';
import { config } from '../config.js';

// A small time-step window (±1 step = ±30s) tolerates clock drift without
// meaningfully widening the brute-force window.
authenticator.options = { window: 1, step: 30 };

const ENC_KEY = Buffer.from(config.TOTP_ENC_KEY, 'hex'); // 32 bytes
const ALGO = 'aes-256-gcm';

export function generateTotpSecret() {
  return authenticator.generateSecret();
}

export function buildOtpauthUri(secret, username, issuer = 'VPS Console') {
  return authenticator.keyuri(username, issuer, secret);
}

export async function totpQrDataUrl(otpauthUri) {
  return QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: 'M', margin: 1 });
}

export function verifyTotpToken(secret, token) {
  if (!/^\d{6}$/.test(token)) return false;
  try {
    return authenticator.check(token, secret);
  } catch {
    return false;
  }
}

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(payload) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

const BACKUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function generateBackupCode() {
  let code = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) {
    code += BACKUP_CODE_ALPHABET[bytes[i] % BACKUP_CODE_ALPHABET.length];
    if (i === 4) code += '-';
  }
  return code;
}

export function generateBackupCodes(count = 10) {
  return Array.from({ length: count }, generateBackupCode);
}

export async function hashBackupCode(code) {
  return argon2.hash(code.toUpperCase(), { type: argon2.argon2id });
}

export async function verifyBackupCode(hash, code) {
  try {
    return await argon2.verify(hash, code.toUpperCase());
  } catch {
    return false;
  }
}
