import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "build/", "etc/", "node_modules/", "docs/examples/"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-warning-comments": ["error", { terms: ["todo", "fixme", "hack", "xxx"], location: "anywhere" }],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@strevokit/signaling-protocol/conformance",
              message: "Conformance samples are test-only and must never be bundled.",
            },
          ],
        },
      ],
    },
  },
);
