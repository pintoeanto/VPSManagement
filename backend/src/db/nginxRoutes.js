import { db } from './index.js';

// Plain prepared-statement data access, matching the rest of the app (no
// ORM). Route metadata is application-level bookkeeping layered on top of
// the real runtime source of truth (the NGINX files themselves) — see
// migrations/002_nginx_routes.sql.

const COLUMNS = [
  'name', 'project_name', 'config_file_name', 'public_hostname',
  'backend_protocol', 'backend_host', 'backend_port', 'backend_base_path',
  'health_check_path', 'preserve_incoming_path', 'websocket_enabled',
  'ignore_backend_tls_errors', 'connect_timeout_seconds', 'read_timeout_seconds',
  'send_timeout_seconds', 'enabled', 'maintenance_mode', 'maintenance_message',
  'maintenance_start', 'maintenance_end', 'description', 'tags',
  'support_email', 'support_phone', 'portal_url', 'notes',
];

// Single source of truth for snake_case (SQLite columns) <-> camelCase (JS
// consumers — the config generator and deploy orchestrator read route.*
// exclusively in camelCase). Every row returned from this module carries
// BOTH forms of every field: the raw snake_case columns (spread from the
// row as-is, which is what the REST API has always returned to the
// frontend) plus a complete set of camelCase aliases generated from this
// map, rather than the previous handful of ad hoc aliases that silently
// left most fields undefined for camelCase readers.
const CAMEL_TO_COLUMN = {
  projectName: 'project_name',
  configFileName: 'config_file_name',
  publicHostname: 'public_hostname',
  backendProtocol: 'backend_protocol',
  backendHost: 'backend_host',
  backendPort: 'backend_port',
  backendBasePath: 'backend_base_path',
  healthCheckPath: 'health_check_path',
  preserveIncomingPath: 'preserve_incoming_path',
  websocketEnabled: 'websocket_enabled',
  ignoreBackendTlsErrors: 'ignore_backend_tls_errors',
  connectTimeoutSeconds: 'connect_timeout_seconds',
  readTimeoutSeconds: 'read_timeout_seconds',
  sendTimeoutSeconds: 'send_timeout_seconds',
  maintenanceMode: 'maintenance_mode',
  maintenanceMessage: 'maintenance_message',
  maintenanceStart: 'maintenance_start',
  maintenanceEnd: 'maintenance_end',
  supportEmail: 'support_email',
  supportPhone: 'support_phone',
  portalUrl: 'portal_url',
  certificateStatus: 'certificate_status',
  certificateExpiry: 'certificate_expiry',
  healthStatus: 'health_status',
  lastHealthError: 'last_health_error',
  consecutiveFailures: 'consecutive_failures',
  lastDeployedAt: 'last_deployed_at',
  lastHealthCheckAt: 'last_health_check_at',
  lastHealthyAt: 'last_healthy_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const BOOLEAN_COLUMNS = new Set(['preserve_incoming_path', 'websocket_enabled', 'ignore_backend_tls_errors', 'enabled', 'maintenance_mode']);

function rowToRoute(row) {
  if (!row) return null;
  const camel = {};
  for (const [camelKey, column] of Object.entries(CAMEL_TO_COLUMN)) {
    camel[camelKey] = BOOLEAN_COLUMNS.has(column) ? !!row[column] : row[column];
  }
  return {
    ...row,
    ...camel,
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

export function listRoutes() {
  return db.prepare('SELECT * FROM nginx_routes ORDER BY name COLLATE NOCASE').all().map(rowToRoute);
}

export function getRoute(id) {
  return rowToRoute(db.prepare('SELECT * FROM nginx_routes WHERE id = ?').get(id));
}

export function getRouteByConfigFileName(configFileName) {
  return rowToRoute(db.prepare('SELECT * FROM nginx_routes WHERE config_file_name = ?').get(configFileName));
}

export function getRouteByHostname(hostname) {
  return rowToRoute(db.prepare('SELECT * FROM nginx_routes WHERE public_hostname = ?').get(hostname));
}

export function createRoute(fields) {
  const now = new Date().toISOString();
  const payload = {
    name: fields.name,
    project_name: fields.projectName ?? null,
    config_file_name: fields.configFileName,
    public_hostname: fields.publicHostname,
    backend_protocol: fields.backendProtocol ?? 'http',
    backend_host: fields.backendHost,
    backend_port: fields.backendPort,
    backend_base_path: fields.backendBasePath ?? '/',
    health_check_path: fields.healthCheckPath ?? '/',
    preserve_incoming_path: fields.preserveIncomingPath === false ? 0 : 1,
    websocket_enabled: fields.websocketEnabled ? 1 : 0,
    ignore_backend_tls_errors: fields.ignoreBackendTlsErrors ? 1 : 0,
    connect_timeout_seconds: fields.connectTimeoutSeconds ?? 10,
    read_timeout_seconds: fields.readTimeoutSeconds ?? 60,
    send_timeout_seconds: fields.sendTimeoutSeconds ?? 60,
    description: fields.description ?? null,
    tags: fields.tags ? JSON.stringify(fields.tags) : null,
    support_email: fields.supportEmail ?? null,
    support_phone: fields.supportPhone ?? null,
    portal_url: fields.portalUrl ?? null,
    notes: fields.notes ?? null,
  };
  const cols = Object.keys(payload);
  const stmt = db.prepare(
    `INSERT INTO nginx_routes (${cols.join(', ')}, created_at, updated_at) VALUES (${cols.map((c) => '@' + c).join(', ')}, @created_at, @updated_at)`
  );
  const info = stmt.run({ ...payload, created_at: now, updated_at: now });
  return getRoute(info.lastInsertRowid);
}

export function updateRoute(id, fields) {
  const allowed = Object.keys(fields).filter((k) => COLUMNS.includes(k) || k in CAMEL_TO_COLUMN);
  if (allowed.length === 0) return getRoute(id);
  const sets = [];
  const params = { id };
  for (const key of allowed) {
    const col = CAMEL_TO_COLUMN[key] ?? key;
    sets.push(`${col} = @${col}`);
    let value = fields[key];
    if (typeof value === 'boolean') value = value ? 1 : 0;
    if (col === 'tags' && Array.isArray(value)) value = JSON.stringify(value);
    params[col] = value;
  }
  sets.push('updated_at = @updated_at');
  params.updated_at = new Date().toISOString();
  db.prepare(`UPDATE nginx_routes SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getRoute(id);
}

export function deleteRoute(id) {
  db.prepare('DELETE FROM nginx_routes WHERE id = ?').run(id);
}

export function recordHealthCheck(routeId, { status, responseTimeMs, httpStatus, error }) {
  db.prepare(
    'INSERT INTO nginx_route_health_history (route_id, status, response_time_ms, http_status, error) VALUES (?, ?, ?, ?, ?)'
  ).run(routeId, status, responseTimeMs ?? null, httpStatus ?? null, error ?? null);
}

export function getHealthHistory(routeId, limit = 50) {
  return db
    .prepare('SELECT * FROM nginx_route_health_history WHERE route_id = ? ORDER BY id DESC LIMIT ?')
    .all(routeId, Math.min(Math.max(Number(limit) || 50, 1), 200));
}
