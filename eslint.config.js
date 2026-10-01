import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "plugins/aion-presence/runtime/**", ".e2e/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Plugin mode never talks to a language-model API, never opens a microphone and never makes a WebRTC
    // connection: Codex is the intelligence. These are enforced here and by tests/apiIndependence.test.ts.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error",
        { name: "RTCPeerConnection", message: "Aion Presence has no WebRTC model session; Codex is the host AI." }],
      "no-restricted-properties": ["error",
        { object: "mediaDevices", property: "getUserMedia", message: "Plugin mode never opens a second microphone." }],
    },
  },
);
