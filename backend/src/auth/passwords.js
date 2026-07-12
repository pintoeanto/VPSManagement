import argon2 from 'argon2';
import { z } from 'zod';

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(256)
  .refine((pw) => /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw), {
    message: 'Password must contain upper, lower, and numeric characters',
  });

export const usernameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username may only contain letters, digits, dot, dash, underscore');

export async function hashPassword(password) {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456, // ~19 MiB, OWASP-recommended minimum for argon2id
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
