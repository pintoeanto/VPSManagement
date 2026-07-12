#!/usr/bin/env node
// Bootstraps the first (or an additional) admin user. Run locally on the VPS
// with `npm run bootstrap-admin` — this requires shell access to the host
// already, so it intentionally has no HTTP-reachable equivalent (no open
// self-registration endpoint exists).
//
// Interactive:     npm run bootstrap-admin
// Non-interactive:  npm run bootstrap-admin -- --username admin --password 'Str0ngPassphrase!'
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { db } from '../db/index.js';
import { hashPassword, passwordSchema, usernameSchema } from '../auth/passwords.js';

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--username') flags.username = argv[++i];
    else if (argv[i] === '--password') flags.password = argv[++i];
  }
  return flags;
}

async function promptMissing(flags) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (!flags.username) flags.username = await rl.question('Admin username: ');
    if (!flags.password) {
      const password = await rl.question('Admin password (min 12 chars, upper/lower/digit): ');
      const confirm = await rl.question('Confirm password: ');
      if (confirm !== password) {
        console.error('Passwords did not match.');
        process.exitCode = 1;
        return null;
      }
      flags.password = password;
    }
    return flags;
  } finally {
    rl.close();
  }
}

async function main() {
  let flags = parseFlags(process.argv.slice(2));
  if (!flags.username || !flags.password) {
    flags = await promptMissing(flags);
    if (!flags) return;
  }

  const usernameCheck = usernameSchema.safeParse(flags.username);
  if (!usernameCheck.success) {
    console.error('Invalid username:', usernameCheck.error.issues.map((i) => i.message).join('; '));
    process.exitCode = 1;
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(usernameCheck.data);
  if (existing) {
    console.error(`User "${usernameCheck.data}" already exists.`);
    process.exitCode = 1;
    return;
  }

  const passwordCheck = passwordSchema.safeParse(flags.password);
  if (!passwordCheck.success) {
    console.error('Invalid password:', passwordCheck.error.issues.map((i) => i.message).join('; '));
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(passwordCheck.data);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(usernameCheck.data, hash);
  console.log(`Created user "${usernameCheck.data}". TOTP will be enrolled on first login.`);
}

main();
