import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Test doubles stand in for context values, streams and fetch Responses
    // while implementing only the handful of fields a case actually reads.
    // Spelling those partial shapes out as real types would describe the
    // mock rather than the contract, so `any` is allowed here — and only
    // here, since production code has no such excuse.
    files: ["__tests__/**/*.{ts,tsx}", "jest.setup.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
]);

export default eslintConfig;
