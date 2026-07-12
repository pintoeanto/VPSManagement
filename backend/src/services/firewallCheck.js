import { runHelperScript } from '../exec/sudoExec.js';

// A spawn-level failure (missing sudo binary, helper script unreadable,
// etc.) throws from runHelperScript rather than resolving with
// success:false — that's the right behavior for a mutating action, where
// the caller needs to know the difference between "ran and failed" and
// "never ran at all". But a *read-only, best-effort* check like this one is
// typically combined with several others in a single Promise.all — one hard
// throw there must not take down every other check's result along with it,
// so failures are caught and turned into a graceful "couldn't determine"
// state instead of propagating.
async function tryRunHelper(key, args) {
  try {
    return await runHelperScript(key, args);
  } catch (err) {
    return { success: false, stdout: '', stderr: err.message };
  }
}

export async function checkFirewallPort(port, protocol = 'tcp') {
  const [ufwResult, listenResult] = await Promise.all([
    tryRunHelper('UFW_RULE', ['status']),
    tryRunHelper('PORT_CHECK', [String(port), protocol]),
  ]);
  // A bare "51820 ALLOW" ufw rule (no /tcp or /udp suffix) opens both
  // protocols, so it counts as a match for either check; a suffixed rule
  // only counts for its own protocol.
  const ufwAllowed = ufwResult.success && new RegExp(`(^|\\s)${port}(/${protocol})?\\s+ALLOW`, 'im').test(ufwResult.stdout);
  const listening = listenResult.success && listenResult.stdout.trim().length > 0;
  return {
    port,
    protocol,
    ufwAllowed,
    listening,
    listenInfo: listening ? listenResult.stdout.trim() : null,
    ufwStatusRaw: ufwResult.success ? ufwResult.stdout.trim() : null,
    checkError: !ufwResult.success && !listenResult.success ? (ufwResult.stderr || listenResult.stderr) : null,
  };
}
