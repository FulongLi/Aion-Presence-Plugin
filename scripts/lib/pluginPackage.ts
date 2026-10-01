import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

/**
 * Static checks for the Aion Presence plugin package, following the Agent Plugins 1.0.0 specification
 * (plugin.json, mcp.json, skills/, path containment) plus the Codex conventions this package relies on
 * (extensions.com.openai interface, hooks/hooks.json, a repo marketplace). Used by `npm run plugin:validate`
 * and by the tests, so the shipped package and the checks can never drift apart.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PLUGIN_ROOT = join(REPO_ROOT, "plugins", "aion-presence");
export const MARKETPLACE = join(REPO_ROOT, ".agents", "plugins", "marketplace.json");
const SCHEMAS = join(REPO_ROOT, "schemas", "agent-plugins", "1.0.0");

/** Hook events Codex documents for command hooks. */
export const CODEX_HOOK_EVENTS = [
  "SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse",
  "PermissionRequest", "PreCompact", "PostCompact", "UserPromptSubmit", "Stop", "Interrupt",
] as const;

/** Files the built runtime must contain (npm run build). */
export const RUNTIME_FILES = ["runtime/aion-mcp.mjs", "runtime/aion-hook.mjs", "runtime/presence.html"] as const;

export interface Issue { level: "error" | "warning"; where: string; message: string }

export interface SkillInfo { dir: string; name: string; description: string; body: string }

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A plugin-relative path ("./…") resolved inside `root`, or null when it is malformed or escapes the root. */
export function containedPath(root: string, value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("./")) return null;
  const target = resolve(root, value);
  const inside = (path: string, base: string) => path === base || path.startsWith(base + sep);
  if (!inside(target, resolve(root))) return null;
  // Symlinks may point within the root but never out of it.
  if (existsSync(target) && !inside(realpathSync(target), realpathSync(root))) return null;
  return target;
}

/** Minimal frontmatter reader for SKILL.md: `key: value` lines between `---` fences. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return null;
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    data[field[1]] = field[2].replace(/^(["'])(.*)\1$/, "$2").trim();
  }
  return { data, body: match[2] };
}

/** Skills discovered the way the specification describes: immediate children of skills/ holding a regular SKILL.md. */
export function discoverSkills(root = PLUGIN_ROOT): SkillInfo[] {
  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir)) return [];
  const skills: SkillInfo[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const parsed = parseFrontmatter(readFileSync(file, "utf8"));
    skills.push({ dir: entry.name, name: parsed?.data.name ?? "", description: parsed?.data.description ?? "", body: parsed?.body ?? "" });
  }
  return skills;
}

function schemaValidator(file: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(readJson(join(SCHEMAS, file)) as object);
}

export function validatePluginPackage(options: { root?: string; marketplace?: string; requireRuntime?: boolean } = {}): Issue[] {
  const root = options.root ?? PLUGIN_ROOT;
  const issues: Issue[] = [];
  const error = (where: string, message: string) => issues.push({ level: "error", where, message });
  const warn = (where: string, message: string) => issues.push({ level: "warning", where, message });

  // plugin.json
  const manifestPath = join(root, "plugin.json");
  let manifest: Record<string, unknown> = {};
  if (!existsSync(manifestPath)) error("plugin.json", "missing");
  else {
    const value = readJson(manifestPath);
    const validate = schemaValidator("plugin.schema.json");
    if (!validate(value)) for (const e of validate.errors ?? []) error("plugin.json", `${e.instancePath || "/"} ${e.message}`);
    if (isRecord(value)) manifest = value;
  }
  if (existsSync(join(root, ".codex-plugin", "plugin.json"))) {
    warn(".codex-plugin/plugin.json", "present: extensions.com.openai in plugin.json supersedes it, so the two would drift");
  }
  const openai = isRecord(manifest.extensions) && isRecord(manifest.extensions["com.openai"]) ? manifest.extensions["com.openai"] : null;
  const ui = openai && isRecord(openai.interface) ? openai.interface : null;
  if (!ui) error("plugin.json", "extensions.com.openai.interface is missing");
  else {
    for (const field of ["displayName", "shortDescription", "developerName", "category"]) {
      if (typeof ui[field] !== "string" || !(ui[field] as string).trim()) error("plugin.json", `interface.${field} is missing`);
    }
    for (const field of ["composerIcon", "logo"]) {
      if (ui[field] === undefined) continue;
      const path = containedPath(root, ui[field]);
      if (!path) error("plugin.json", `interface.${field} must be a "./" path inside the plugin root`);
      else if (!existsSync(path)) error("plugin.json", `interface.${field} does not exist: ${ui[field]}`);
    }
  }

  // mcp.json
  const mcpPath = join(root, "mcp.json");
  if (!existsSync(mcpPath)) error("mcp.json", "missing");
  else {
    const value = readJson(mcpPath);
    const validate = schemaValidator("mcp.schema.json");
    if (!validate(value)) for (const e of validate.errors ?? []) error("mcp.json", `${e.instancePath || "/"} ${e.message}`);
    const servers = isRecord(value) && isRecord(value.mcpServers) ? value.mcpServers : {};
    for (const [name, server] of Object.entries(servers)) {
      if (!isRecord(server)) continue;
      if (server.type === "stdio" && typeof server.command === "string" && /\s/.test(server.command)) {
        error("mcp.json", `${name}: command must be a single executable token`);
      }
      for (const arg of Array.isArray(server.args) ? server.args : []) {
        if (typeof arg !== "string" || !arg.startsWith("${PLUGIN_ROOT}/")) continue;
        const path = containedPath(root, `./${arg.slice("${PLUGIN_ROOT}/".length)}`);
        if (!path) error("mcp.json", `${name}: ${arg} escapes the plugin root`);
        else if (options.requireRuntime && !existsSync(path)) error("mcp.json", `${name}: ${arg} does not exist (run npm run build)`);
      }
      const env = isRecord(server.env) ? Object.keys(server.env) : [];
      if (env.some(key => /OPENAI|API_KEY|TOKEN|SECRET/i.test(key))) error("mcp.json", `${name}: plugin mode must not require credentials`);
    }
  }

  // skills/
  const skills = discoverSkills(root);
  if (!skills.length) error("skills/", "no skill found");
  for (const skill of skills) {
    const where = `skills/${skill.dir}/SKILL.md`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || skill.name.length > 64) error(where, "name must be lower-case words joined by hyphens (max 64)");
    if (skill.name !== skill.dir) error(where, `name "${skill.name}" must match its directory "${skill.dir}"`);
    if (!skill.description || skill.description.length > 1024) error(where, "description is required (max 1024 characters)");
    if (!skill.body.trim()) error(where, "has no instructions");
  }

  // hooks/hooks.json (Codex's default hook location)
  const hooksPath = join(root, "hooks", "hooks.json");
  if (existsSync(hooksPath)) {
    const value = readJson(hooksPath);
    const hooks = isRecord(value) && isRecord(value.hooks) ? value.hooks : null;
    if (!hooks) error("hooks/hooks.json", "must contain a hooks object");
    for (const [event, groups] of Object.entries(hooks ?? {})) {
      if (!(CODEX_HOOK_EVENTS as readonly string[]).includes(event)) error("hooks/hooks.json", `unknown event ${event}`);
      if (!Array.isArray(groups)) { error("hooks/hooks.json", `${event} must be an array`); continue; }
      for (const group of groups) {
        const handlers = isRecord(group) && Array.isArray(group.hooks) ? group.hooks : null;
        if (!handlers?.length) { error("hooks/hooks.json", `${event}: every group needs hooks`); continue; }
        for (const handler of handlers) {
          if (!isRecord(handler) || handler.type !== "command" || typeof handler.command !== "string") {
            error("hooks/hooks.json", `${event}: handlers must be { type: "command", command }`);
            continue;
          }
          if (typeof handler.timeout !== "number" || handler.timeout > 10) error("hooks/hooks.json", `${event}: set a short timeout (≤ 10 s) so a hook can never stall Codex`);
          const script = /\$\{PLUGIN_ROOT\}\/([^\s"']+)/.exec(handler.command)?.[1];
          if (script && options.requireRuntime && !existsSync(join(root, script))) error("hooks/hooks.json", `${event}: ${script} does not exist (run npm run build)`);
        }
      }
    }
  }

  // Built runtime.
  if (options.requireRuntime) {
    for (const file of RUNTIME_FILES) if (!existsSync(join(root, file))) error(file, "missing (run npm run build)");
  }

  // Repo marketplace.
  const marketplacePath = options.marketplace ?? MARKETPLACE;
  if (existsSync(marketplacePath)) {
    const market = readJson(marketplacePath);
    const marketRoot = resolve(dirname(marketplacePath), "..", "..");
    const entries = isRecord(market) && Array.isArray(market.plugins) ? market.plugins : [];
    if (!isRecord(market) || typeof market.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(market.name)) error("marketplace.json", "name must be lower-case words joined by hyphens");
    const entry = entries.find(item => isRecord(item) && item.name === manifest.name);
    if (!isRecord(entry)) error("marketplace.json", `no entry for ${String(manifest.name)}`);
    else {
      const source = isRecord(entry.source) ? entry.source : {};
      const path = containedPath(marketRoot, source.path);
      if (source.source !== "local" || !path) error("marketplace.json", 'source must be { source: "local", path: "./…" } inside the marketplace root');
      else if (resolve(path) !== resolve(root)) error("marketplace.json", `source.path points at ${relative(marketRoot, path)}, not this plugin`);
    }
  }
  return issues;
}
