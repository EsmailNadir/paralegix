import next from "eslint-config-next";

const eslintConfig = [
  ...next,
  { ignores: ["coverage/**", ".next/**", "out/**"] },
  {
    // Root config files aren't app source and trip TypeScript-only rules from the
    // Next config that aren't registered for plain JS (e.g. no-require-imports).
    ignores: ["jest.config.js"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "warn",
    },
  },
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    rules: {
      "react/no-unescaped-entities": "off",
      // The React Compiler hook rules ship as errors in eslint-config-next 16.
      // `set-state-in-effect` and `preserve-manual-memoization` are ENFORCED:
      // every existing site was reviewed and either rewritten (corrective state
      // moved into render) or annotated with a specific eslint-disable reason for
      // the legitimate effect patterns (data fetch, subscriptions, modal form-sync,
      // animation), so the rules now catch genuinely new violations.
      //
      // `immutability`, `refs`, and `purity` stay off: a full triage found their
      // reports are all intentional React idioms (mirror-state-into-a-ref, clock
      // reads in render) or false-positives (declaration ordering), not bugs.
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
    },
  },
];

export default eslintConfig;
