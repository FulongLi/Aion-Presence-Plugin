import { relative } from "node:path";
import { PLUGIN_ROOT, REPO_ROOT, validatePluginPackage } from "./lib/pluginPackage";

/** `npm run plugin:validate [-- --runtime]`: static checks of the plugin package (see lib/pluginPackage.ts). */
const requireRuntime = process.argv.includes("--runtime");
const issues = validatePluginPackage({ requireRuntime });
for (const issue of issues) console.log(`${issue.level === "error" ? "✗" : "!"} ${issue.where}: ${issue.message}`);
const errors = issues.filter(issue => issue.level === "error").length;
console.log(errors
  ? `\n${errors} error(s) in ${relative(REPO_ROOT, PLUGIN_ROOT)}`
  : `✓ ${relative(REPO_ROOT, PLUGIN_ROOT)} is a valid Agent Plugins package${requireRuntime ? " with its built runtime" : ""}`);
process.exit(errors ? 1 : 0);
