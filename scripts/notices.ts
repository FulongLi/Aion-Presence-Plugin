import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ROOT, REPO_ROOT } from "./lib/pluginPackage";

/**
 * `npm run notices`: plugins/aion-presence/THIRD-PARTY-NOTICES.md — the license of every third-party component the built
 * runtime bundles, verbatim, so the notices travel with every copy of the plugin (MIT and Apache-2.0 require it; the
 * OFL travels with the font). The Chinese Writing Pack's data has its own licenses in packs/chinese-writing.
 */
const COMPONENTS: { name: string; use: string; license: string; file?: string }[] = [
  { name: "three", use: "the WebGPU particle renderer", license: "MIT" },
  { name: "vexflow", use: "music notation engraving", license: "MIT" },
  { name: "hanzi-writer", use: "Chinese writing practice (the tracing quiz); its rendering technique for the reference card", license: "MIT" },
  { name: "zod", use: "input validation", license: "MIT" },
  { name: "@modelcontextprotocol/server", use: "the MCP server", license: "MIT / Apache-2.0" },
  { name: "@modelcontextprotocol/core", use: "the MCP protocol", license: "MIT / Apache-2.0" },
  { name: "@modelcontextprotocol/ext-apps", use: "the MCP Apps surface", license: "MIT / Apache-2.0" },
];

const sections = COMPONENTS.map(component => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", component.name, "package.json"), "utf8")) as { version: string; homepage?: string };
  const text = readFileSync(join(REPO_ROOT, "node_modules", component.name, component.file ?? "LICENSE"), "utf8").trim();
  return `## ${component.name} ${pkg.version}\n\nUsed for ${component.use}. License: ${component.license}.${pkg.homepage ? ` ${pkg.homepage}` : ""}\n\n\`\`\`text\n${text}\n\`\`\``;
});
sections.push(`## Bravura (music font, bundled through VexFlow)\n\nUsed for engraved notation and the outlines of the body's music symbols. © Steinberg Media Technologies GmbH. License: SIL Open Font License 1.1. https://github.com/steinbergmedia/bravura\n\n\`\`\`text\n${readFileSync(join(REPO_ROOT, "scripts", "notices", "bravura-OFL.txt"), "utf8").trim()}\n\`\`\``);
const out = `# Third-party notices\n\nAion Presence's runtime (\`runtime/\`) bundles the components below. Their licenses follow, verbatim. The Chinese Writing\nPack (\`packs/chinese-writing\`) is separately licensed data; see its \`NOTICE.md\` and license files.\n\n${sections.join("\n\n")}\n`;
writeFileSync(join(PLUGIN_ROOT, "THIRD-PARTY-NOTICES.md"), out);
console.log(`plugins/aion-presence/THIRD-PARTY-NOTICES.md: ${COMPONENTS.length + 1} components`);
