/**
 * Defines a catalog action. Every mutating capability in this app — installing
 * nginx, adding a WireGuard peer, restarting a service — is one of these, with
 * a typed params schema and an explicit detect/plan/apply lifecycle. There is
 * no other way to reach a privileged operation from the API.
 *
 * @param {object} def
 * @param {string} def.id - stable identifier, e.g. "nginx.install"
 * @param {string} def.category - e.g. "nginx" | "wireguard" | "mosquitto" | "nodejs" | "service" | "system"
 * @param {string} def.label - human-readable name for the UI
 * @param {import('zod').ZodTypeAny} def.paramsSchema
 * @param {(params: any) => Promise<any>} def.detect - inspect current state, no mutation
 * @param {(params: any, detectResult: any) => Promise<any>} def.plan - describe what would change, no mutation
 * @param {(params: any, detectResult: any, planResult: any) => Promise<any>} def.apply - perform the change
 * @param {boolean} [def.mutating] - defaults to true; set false for pure read/status actions
 */
export function defineAction(def) {
  const required = ['id', 'category', 'label', 'paramsSchema', 'detect', 'plan', 'apply'];
  for (const key of required) {
    if (!(key in def)) {
      throw new Error(`Action definition missing required field "${key}"`);
    }
  }
  return { mutating: true, ...def };
}
