// SPDX-License-Identifier: Apache-2.0
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mts"],
    rules: { "no-undef": "off" },
  },
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
      ".local/**",
      ".claude/**",
      "infra/**",
    ],
  },
);
