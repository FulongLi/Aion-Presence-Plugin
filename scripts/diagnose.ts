import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HUB_FILE, presenceHome, TOKEN_FILE } from "../src/host/paths";

/**
 * `npm run diagnose`: the live diagnostics of every Aion window opened with ?debug=1 (see docs/MICROPHONE.md),
 * printed here once a second — readable while the window itself is fullscreen. Local only: it reads the hub on
 * 127.0.0.1 with the per-user token. AION_PRESENCE_HOME selects another hub; `-- --once` prints once.
 */
const home = process.env.AION_PRESENCE_HOME ?? presenceHome();
let url: string, token: string;
try {
  url = (JSON.parse(readFileSync(join(home, HUB_FILE), "utf8")) as { url: string }).url;
  token = readFileSync(join(home, TOKEN_FILE), "utf8").trim();
} catch { console.error(`diagnose: no running Aion hub in ${home} (open Aion first)`); process.exit(1); }
const once = process.argv.includes("--once");
for (;;) {
  try {
    const windows = await (await fetch(new URL("api/diagnostics", url), { headers: { "x-aion-token": token } })).json() as Record<string, { lines: Record<string, string> }>;
    const entries = Object.entries(windows);
    console.log(entries.length ? entries.map(([id, item]) => [`window ${id}`, ...Object.entries(item.lines).map(([key, value]) => `  ${key.padEnd(9)} ${value}`)].join("\n")).join("\n\n")
      : "no window with ?debug=1 is reporting (add &debug=1 to the companion address)");
  } catch { console.log("the hub is not answering"); }
  if (once) break;
  console.log("");
  await new Promise(resolve => setTimeout(resolve, 1_000));
}
