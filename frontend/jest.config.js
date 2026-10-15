// Every run uses the zone CI uses, whatever the shell's own zone is. Date tests
// are written against a viewer behind UTC, where a day-only string misread as
// UTC midnight lands on the previous day. Set here, before Jest starts any
// worker, because each worker inherits this environment when it is spawned; a
// setup file runs too late for code that has already read the zone.
process.env.TZ = "America/Los_Angeles";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const customConfig = {
  testMatch: ["**/tests/**/*.test.{ts,tsx}"],
  testEnvironment: "jsdom",
  // Native coverage preserves functions serialized into Web Worker scripts.
  coverageProvider: "v8",
  setupFilesAfterEnv: ["./tests/setup.ts"],
  collectCoverageFrom: ["src/**/*.{ts,tsx}", "!src/**/*.d.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
};

module.exports = createJestConfig(customConfig);
