#!/usr/bin/env node
// CLI wrapper around ExtensionCaller for the composite action.
//
//   node caller.mjs --phase pre-validate [--config .cairnci/extensions.json] [--context '{"k":"v"}']
//
// Exit codes: 0 = all extensions ok/warn (or none configured), 1 = a blocking
// extension errored, 2 = the config or invocation itself is invalid.

import { ExtensionCaller, ConfigError } from "./lib/extension-caller.mjs";

function parseArgs(argv) {
  const opts = { config: ".cairnci/extensions.json", context: "{}" };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new ConfigError(`missing value for ${flag}`);
    if (flag === "--phase") opts.phase = value;
    else if (flag === "--config") opts.config = value;
    else if (flag === "--context") opts.context = value;
    else throw new ConfigError(`unknown flag ${flag}`);
  }
  if (!opts.phase) throw new ConfigError("--phase is required");
  return opts;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  let context = {};
  try { context = JSON.parse(opts.context); }
  catch { console.log(`::warning::Could not parse --context as JSON — passing {} to extensions.`); }

  const caller = new ExtensionCaller({ configFile: opts.config });
  const { failed, results } = caller.runPhase(opts.phase, context);
  const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  console.log(`Phase '${opts.phase}' complete: ${results.length} extension(s) — ok=${counts.ok || 0} warn=${counts.warn || 0} error=${counts.error || 0}.`);
  process.exit(failed ? 1 : 0);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`::error::Extensions config invalid: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
