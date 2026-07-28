// ESLint flat config.
//
// The ruleset is deliberately smaller than `recommendedTypeChecked`, and the
// reason is this codebase's domain rather than a tolerance for slop.
//
// Everything that enters this process is `Record<string, unknown>` decoded from
// Coolify's JSON — an API whose OpenAPI document is generated from PHP
// attributes and is wrong in places (see the Limitations section of the
// README). `no-base-to-string`, `no-unsafe-return` and the rest of the
// `no-unsafe-*` family fire on essentially every line that touches a response
// body, where defensive `String(x)` is the correct move and not an oversight.
// A ruleset that flags the codebase's central idiom on every file is a ruleset
// contributors learn to run with `--no-eslintrc`, so those rules are not
// enabled and this comment is the record of why.
//
// What remains earns its place: the promise rules catch a class of bug that
// kills the process and that TypeScript cannot see, and the stdout ban below
// protects the one invariant the server cannot survive losing.
//
// Formatting is not this file's business. `eslint-config-prettier` is last in
// the chain and switches off every stylistic rule, so the two tools cannot
// disagree about a comma and produce a red build that no edit satisfies.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // Flat config has no `.eslintignore`; ignores live here and, in a bare
    // object with nothing else in it, apply globally.
    //
    // `src/generated/` is owned by `npm run codegen`, and CI fails on any diff
    // against it. A lint rule that wanted a change there would deadlock the two
    // checks against each other.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/generated/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Type-aware linting, for the handful of rules below that need it.
        // `projectService` is the flat-config replacement for listing tsconfigs
        // by hand: it asks the TS language service which project owns each
        // file, so test/ and scripts/ are covered without a second tsconfig
        // that could drift from the first.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The reason this file enables type-aware linting at all.
      //
      // A rejected promise nobody awaits becomes an unhandled rejection, and in
      // Node an unhandled rejection terminates the process. For an MCP server
      // that is the client showing "server disconnected" with the cause printed
      // on neither side of the pipe. TypeScript cannot see it; this can.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',

      // Unused arguments are frequently deliberate in the handler signatures the
      // MCP SDK dictates. Underscore is the opt-out; everything else is either
      // dead code or a rename that missed a spot.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // `unknown` is the right shape for anything crossing a boundary, and the
      // codebase already uses it. A warning rather than an error: an `any` that
      // creeps in should be visible without failing a build over a cast a
      // reviewer has already reasoned about.
      '@typescript-eslint/no-explicit-any': 'warn',

      // U+FEFF appears as a literal in the BOM-stripping regex in the installer
      // test harness, which is exactly the character that code exists to remove.
      // Flagging it there is the rule misfiring on its own subject matter.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },

  {
    // STDOUT IS THE JSON-RPC CHANNEL. One stray `console.log` anywhere the
    // server can reach desynchronises the stdio framing, and the client drops
    // the connection with an error naming neither the line nor this process.
    // It is the single worst failure mode this codebase has, it is one
    // character to introduce, and it is invisible in review — so it is a lint
    // error rather than a comment asking people to be careful.
    //
    // `src/cli.ts` is excluded: it is a terminal program whose entire output
    // contract is stdout, and it never speaks MCP.
    files: ['src/**/*.ts'],
    ignores: ['src/cli.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'stdout',
          message:
            'stdout carries JSON-RPC. Write diagnostics to process.stderr — see the header of src/index.ts.',
        },
      ],
    },
  },

  {
    // Test doubles implement async interfaces with synchronous bodies, and
    // vitest's `expect(obj.method)` reads a method off its object by design.
    // Both rules are correct about production code and wrong about a mock.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  {
    // These are not in any tsconfig `include`, so type-aware rules have no
    // program to consult for them.
    files: ['*.config.js', '*.config.ts', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Last, always: turns off everything that would fight Prettier.
  prettier,
);
