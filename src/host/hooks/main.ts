import { runHook } from "./forward";

/** Entry point of runtime/aion-hook.mjs: forward the event if Aion is open, then exit 0 whatever happens. */
runHook().catch(() => {}).finally(() => process.exit(0));
