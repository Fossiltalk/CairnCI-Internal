// sf CLI wrappers — the only org IO in this extension. Reuses the session the
// deploy job already established (the extension inherits the authenticated sf
// CLI per docs/extensions.md); no credential inputs, no credential storage.
// The binary is overridable via OMNI_CACHE_REFRESH_SF_BIN so tests can point
// at a stub.

import { spawnSync } from "node:child_process";

export class OrgError extends Error {}

function runSf(args, env = process.env) {
  const bin = env.OMNI_CACHE_REFRESH_SF_BIN || "sf";
  const res = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env });
  if (res.error) throw new OrgError(`failed to run '${bin}': ${res.error.message}`);
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new OrgError(
      `'${bin} ${args.join(" ")}' did not return JSON (exit ${res.status}): ${String(res.stderr || res.stdout).slice(0, 400)}`,
    );
  }
  if (parsed.status !== 0) {
    throw new OrgError(`'${bin} ${args[0]} ${args[1] || ""}' failed: ${parsed.message || JSON.stringify(parsed).slice(0, 400)}`);
  }
  return parsed.result;
}

function orgArgs(targetOrg) {
  return targetOrg ? ["--target-org", targetOrg] : [];
}

/** { instanceUrl, accessToken } for the already-authenticated org session. */
export function orgSession(targetOrg, env = process.env) {
  const r = runSf(["org", "display", ...orgArgs(targetOrg), "--json"], env);
  if (!r?.instanceUrl || !r?.accessToken) {
    throw new OrgError("sf org display returned no instanceUrl/accessToken — is the deploy job's org session available?");
  }
  return { instanceUrl: r.instanceUrl, accessToken: r.accessToken };
}

/** Run one SOQL query, returning the records array. */
export function soqlQuery(soql, targetOrg, env = process.env) {
  const r = runSf(["data", "query", "-q", soql, ...orgArgs(targetOrg), "--json"], env);
  return r?.records || [];
}
