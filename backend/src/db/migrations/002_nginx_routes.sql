-- Route metadata for the guided NGINX route configurator. NGINX files under
-- /etc/nginx/sites-available remain the actual runtime configuration source
-- of truth; this table is application-level bookkeeping layered on top
-- (health history, TLS status, maintenance mode, wizard-entered fields) for
-- routes created through the configurator. Never stores certificate/key
-- material — only paths and status certbot already manages.
CREATE TABLE IF NOT EXISTS nginx_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  project_name TEXT,
  config_file_name TEXT NOT NULL UNIQUE,
  public_hostname TEXT NOT NULL,
  backend_protocol TEXT NOT NULL DEFAULT 'http',
  backend_host TEXT NOT NULL,
  backend_port INTEGER NOT NULL,
  backend_base_path TEXT NOT NULL DEFAULT '/',
  health_check_path TEXT NOT NULL DEFAULT '/',
  preserve_incoming_path INTEGER NOT NULL DEFAULT 1,
  websocket_enabled INTEGER NOT NULL DEFAULT 0,
  ignore_backend_tls_errors INTEGER NOT NULL DEFAULT 0,
  connect_timeout_seconds INTEGER NOT NULL DEFAULT 10,
  read_timeout_seconds INTEGER NOT NULL DEFAULT 60,
  send_timeout_seconds INTEGER NOT NULL DEFAULT 60,
  enabled INTEGER NOT NULL DEFAULT 0,
  maintenance_mode INTEGER NOT NULL DEFAULT 0,
  maintenance_message TEXT,
  maintenance_start TEXT,
  maintenance_end TEXT,
  description TEXT,
  tags TEXT,
  support_email TEXT,
  support_phone TEXT,
  portal_url TEXT,
  notes TEXT,
  certificate_status TEXT NOT NULL DEFAULT 'none',
  certificate_expiry TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_health_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_deployed_at TEXT,
  last_health_check_at TEXT,
  last_healthy_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_nginx_routes_hostname ON nginx_routes(public_hostname);

CREATE TABLE IF NOT EXISTS nginx_route_health_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id INTEGER NOT NULL REFERENCES nginx_routes(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status TEXT NOT NULL,
  response_time_ms INTEGER,
  http_status INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_health_history_route ON nginx_route_health_history(route_id, checked_at);
