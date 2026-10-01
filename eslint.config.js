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
    // Plugin mode never talks to a language-model API and never makes a WebRTC connection: Codex is the
    // intelligence. Aion never records, transcribes or speaks. The microphone is opened in one place only
    // (src/surface/microphone.ts) and analysed locally. Enforced here and by tests/apiIndependence.test.ts.
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-globals": ["error",
        { name: "RTCPeerConnection", message: "Aion Presence has no WebRTC model session; Codex is the host AI." },
        { name: "MediaRecorder", message: "Aion never records audio." },
        { name: "SpeechRecognition", message: "Aion never transcribes; Codex owns the conversation." },
        { name: "speechSynthesis", message: "Aion never speaks; Codex owns the voice." }],
      "no-restricted-syntax": ["error",
        { selector: "MemberExpression[property.name='getUserMedia']", message: "The microphone is opened only in src/surface/microphone.ts." }],
    },
  },
  { files: ["src/surface/microphone.ts"], rules: { "no-restricted-syntax": "off" } },
);
