# VPS Management Console

A self-hosted web console for managing a single Ubuntu/Debian VPS: NGINX,
WireGuard, Mosquitto MQTT, Node.js, generic systemd services, and basic
system administration (metrics, apt updates, ufw). It runs **on** the host
it manages, behind password + TOTP two-factor auth, and never executes
arbitrary shell — every privileged operation is one of a fixed, reviewed
catalog of actions.

## Security model (read this first)

- **No arbitrary shell from the web.** The API only exposes a whitelisted
  catalog of actions (`backend/src/catalog/actions/*.js`), each with a typed
  zod schema and an explicit `detect → plan → apply` lifecycle.
- **Least privilege.** The app runs as a dedicated non-root user
  (`vps-console`). Privileged steps run through a small set of root-owned
  helper scripts (`backend/scripts/*.sh`) invoked via `sudo -n` with narrow,
  per-script `NOPASSWD` sudoers rules — never raw shell strings.
- **Idempotent and safe.** Every install/configure action detects current
  state first, backs up any config it's about to touch, writes via
  temp-file-then-atomic-rename, validates syntax before activating
  (`nginx -t`, a `wg-quick strip` parse check, a bounded mosquitto config
  probe), and restores the backup if validation fails.
- **Auth.** Argon2id password hashing, mandatory TOTP (RFC 6238) enrolled on
  first login, hashed one-time backup codes, short-lived (15 min) JWT access
  tokens, rotating refresh tokens in an httpOnly cookie with reuse detection,
  CSRF protection on the cookie-authenticated endpoints, and per-account +
  per-IP rate limiting with lockout.
- **Audit log.** Every privileged action (and every auth event) is appended
  to a tamper-evident, hash-chained audit log, visible in the UI.

## Repo layout

```
backend/    Node.js/Express API, action catalog, root-owned helper scripts
frontend/   React + Vite dark "ops console" UI
deploy/     systemd unit, sudoers snippet, NGINX reverse-proxy vhost
```

## First-run setup (on the VPS)

Target: Ubuntu 22.04/24.04 LTS. All commands below run on the VPS itself.

### 1. Create the dedicated service user and install locations

```bash
sudo useradd --system --home /opt/vps-console --shell /usr/sbin/nologin vps-console
sudo mkdir -p /opt/vps-console
sudo git clone <this-repo-url> /opt/vps-console   # or copy the tree over
```

### 2. Install dependencies and build the frontend

```bash
cd /opt/vps-console/backend && npm install --omit=dev
cd /opt/vps-console/frontend && npm install && npm run build
```

The backend serves `frontend/dist` directly (see `backend/src/app.js`), so
there's no separate frontend process in production.

### 3. Lock down the helper scripts

The helper scripts under `backend/scripts/` **must** be root-owned and not
writable by `vps-console` — that's what makes the sudoers grant safe.

```bash
sudo chown -R root:root /opt/vps-console/backend/scripts
sudo chmod -R 750 /opt/vps-console/backend/scripts
sudo find /opt/vps-console/backend/scripts -name '*.sh' -exec chmod 750 {} \;
```

### 4. Install the sudoers rule

```bash
sudo cp deploy/sudoers/vps-console.sudoers /etc/sudoers.d/vps-console
sudo chmod 440 /etc/sudoers.d/vps-console
sudo visudo -c -f /etc/sudoers.d/vps-console   # must print "parsed OK"
```

If your install path isn't `/opt/vps-console`, edit the absolute paths in
that file (and in the systemd unit and `.env`) to match.

### 5. Configure the app

```bash
cd /opt/vps-console/backend
cp .env.example .env
# Generate secrets:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_ACCESS_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_REFRESH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # TOTP_ENC_KEY
# Edit .env: paste the generated secrets, set HELPER_SCRIPTS_DIR=./scripts,
# JAIL_ROOT, ALLOWED_SERVICE_UNITS, COOKIE_DOMAIN to your actual domain.
sudo mkdir -p /opt/vps-console/backend/data
sudo chown -R vps-console:vps-console /opt/vps-console/backend/data /opt/vps-console/backend/.env
```

### 6. Create the admin account and enroll TOTP

```bash
sudo -u vps-console npm --prefix /opt/vps-console/backend run bootstrap-admin -- \
  --username admin --password 'choose-a-strong-passphrase'
```

TOTP is enrolled interactively on first login through the web UI (it shows a
QR code and 10 one-time backup codes — save the backup codes immediately,
they're shown exactly once).

### 7. Install and start the systemd service

```bash
sudo cp deploy/systemd/vps-console.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vps-console
sudo systemctl status vps-console
```

The service binds to `127.0.0.1:6000` only (see `HOST`/`PORT` in `.env`) —
it is never reachable directly from the network.

## Choosing how to expose it

The backend is loopback-only by design. Pick one:

### Option A — SSH tunnel only (most locked down, no public listener)

Don't install the NGINX vhost at all. From your workstation:

```bash
ssh -L 6001:127.0.0.1:6000 user@your-vps
```

Then browse to `http://127.0.0.1:6001` locally. Nothing is exposed on the
VPS's network interfaces beyond SSH itself.

### Option B — TLS reverse proxy (NGINX + Let's Encrypt)

```bash
sudo cp deploy/nginx/vps-console.conf /etc/nginx/sites-available/vps-console
# edit server_name to your real domain
sudo ln -s /etc/nginx/sites-available/vps-console /etc/nginx/sites-enabled/
sudo certbot --nginx -d console.example.com
sudo nginx -t && sudo systemctl reload nginx
```

By default this listens on the public interface — that's fine, since
password + TOTP + JWT (not network position) is the real security boundary,
and the rate limiting / account lockout in the app is designed for exactly
this exposure. Add `fail2ban` watching `/var/log/nginx/vps-console.error.log`
for an extra layer against brute-force scanning, and keep `ufw` enabled for
everything except 22/80/443.

### Option C — Restrict the TLS listener to a WireGuard tunnel interface

If you'd rather the console only be reachable over a WireGuard tunnel you
already use to reach this VPS (with occasional public-IP access left for a
break-glass path), see the commented alternative block at the bottom of
`deploy/nginx/vps-console.conf` — it binds the HTTPS listener to the tunnel's
interface address instead of `0.0.0.0`, and pairs with a `ufw deny 443/tcp`
rule scoped to the public interface.

## Managed capabilities

- **NGINX** — install, create/update/disable server blocks (static or
  reverse-proxy), Let's Encrypt issuance via certbot. Never reloads a config
  that fails `nginx -t`.
- **WireGuard** — install, initialize the `wg0` server interface, add/remove
  peers (keys generated fresh per peer; the private key is returned exactly
  once in the API response and never stored server-side), live status via
  `wg show`.
- **Mosquitto** — install, configure listeners (port, TLS, anonymous vs
  password-file auth), manage password-file users.
- **Node.js** — detect installed version, install a pinned LTS major via
  NodeSource, refuses to replace an existing different version without an
  explicit confirmation flag.
- **Generic services** — status/start/stop/restart/enable for a whitelisted
  set of units (`ALLOWED_SERVICE_UNITS` in `.env`), bounded read-only
  `journalctl` tail.
- **System** — CPU/memory/disk/uptime metrics, `apt` upgradable list and
  guarded upgrade, `ufw` status and guarded rule add/remove.
- **Files** — upload/download/list/delete confined to a jail directory
  (`JAIL_ROOT`), with path-traversal and symlink-escape checks, extension
  allowlist, size limits, and SHA-256 checksums.

## Development

```bash
# Terminal 1
cd backend && cp .env.example .env   # fill in secrets as above
npm install && npm run dev

# Terminal 2
cd frontend && npm install && npm run dev
```

The Vite dev server proxies `/api` to `http://127.0.0.1:6000` (see
`frontend/vite.config.js`). `npm run dev` is for local development only —
never expose the Vite dev server itself beyond localhost.

Off a real Ubuntu host (e.g. developing on Windows/macOS), the `detect()`
step of nginx/WireGuard/Mosquitto/Node actions degrades gracefully to "not
installed", and anything requiring `sudo` will fail since that binary won't
exist — this is expected and is not something the app needs to handle
specially, since `sudo` is always present on the real Ubuntu target.

## Known limitation

Refresh-token rotation revokes the previous token on every use and treats a
second presentation of an already-rotated token as reuse (compromise
signal), killing the session. The frontend dedupes concurrent refresh calls
from the same tab to avoid tripping this on itself, but two *different*
browser tabs racing to silently refresh at the same moment could still both
attempt to use the same token and one would lose. This is rare in practice
(refreshes happen only near the 15-minute access-token expiry) and the
failure mode is just being asked to log in again, not a security issue.
