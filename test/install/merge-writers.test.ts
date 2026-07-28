/**
 * The four merge writers, at the unit level.
 *
 * The adapter fixtures cover these through the clients that use them, which
 * leaves two holes this file fills:
 *
 *  - THE YAML WRITER HAS NO CALLER. Its only adapter (MiniMax) is print-only, so
 *    every fixture in the suite exercises JSON, JSONC or TOML and the YAML
 *    writer ships completely untested. It is live code the moment MiniMax is
 *    promoted, and the promotion will be a one-line confidence change made by
 *    somebody who is not reading this file.
 *  - THE REFUSAL CONTRACT. `severity: 'error'` in the result means apply() must
 *    not write and `text` must equal the input. It is asserted here per writer
 *    because it is the property that stops one bad key from making a broken
 *    config longer and harder to repair.
 */

import { parse as parseJsonc } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

import { mergeJson, removeJson } from '../../src/install/merge/json.js';
import { mergeJsonc, removeJsonc } from '../../src/install/merge/jsonc.js';
import {
  appendTomlSection,
  hasTomlSection,
  parseTomlDocument,
  removeTomlSection,
  replaceTomlSection,
  splitDottedKey,
} from '../../src/install/merge/toml.js';
import { mergeYaml, removeYaml } from '../../src/install/merge/yaml.js';

const KEY_PATH = ['mcpServers', 'coolify'];
const ENTRY = { command: 'npx', args: ['-y', 'coolify-mcp@1.4.2'] };
const BOM = '﻿';

function errorCodes(issues: ReadonlyArray<{ severity: string; code: string }>): string[] {
  return issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);
}

// ---------------------------------------------------------------------------
// Shared contract
// ---------------------------------------------------------------------------

describe('every writer refuses a file it cannot parse', () => {
  const CASES: ReadonlyArray<
    [
      string,
      () => { text: string; changed: boolean; issues: Array<{ severity: string; code: string }> },
      string,
    ]
  > = [
    ['json', () => mergeJson('{ "mcpServers": ', KEY_PATH, ENTRY), '{ "mcpServers": '],
    [
      'jsonc',
      () => mergeJsonc('{ "context_servers": ', ['context_servers', 'coolify'], ENTRY),
      '{ "context_servers": ',
    ],
    [
      'toml',
      () =>
        appendTomlSection(
          'model = \n[mcp_servers.x]\n',
          'mcp_servers.coolify',
          '[mcp_servers.coolify]\n',
        ),
      'model = \n[mcp_servers.x]\n',
    ],
    [
      'yaml',
      () => mergeYaml('mcp:\n  a: [1, 2\n', ['mcp', 'coolify'], ENTRY),
      'mcp:\n  a: [1, 2\n',
    ],
  ];

  it.each(CASES)(
    '%s reports an error and returns the input untouched',
    (_format, run, original) => {
      const result = run();

      expect(errorCodes(result.issues).length).toBeGreaterThan(0);
      expect(result.changed).toBe(false);
      // Guaranteed by the contract: apply() checks `issues`, but a writer that
      // also mangled `text` would corrupt the file for any caller that did not.
      expect(result.text).toBe(original);
    },
  );
});

describe('every writer is a no-op when nothing moved', () => {
  it('json', () => {
    const first = mergeJson('{}\n', KEY_PATH, ENTRY);
    const second = mergeJson(first.text, KEY_PATH, ENTRY);

    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
  });

  it('jsonc', () => {
    const first = mergeJsonc('{}\n', KEY_PATH, ENTRY);
    const second = mergeJsonc(first.text, KEY_PATH, ENTRY);

    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
  });

  it('yaml', () => {
    const first = mergeYaml('', KEY_PATH, ENTRY);
    const second = mergeYaml(first.text, KEY_PATH, ENTRY);

    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
  });

  it('toml refuses to touch a section it already sees, and says so', () => {
    const first = appendTomlSection(
      '',
      'mcp_servers.coolify',
      '[mcp_servers.coolify]\ncommand = "npx"\n',
    );
    const second = appendTomlSection(
      first.text,
      'mcp_servers.coolify',
      '[mcp_servers.coolify]\ncommand = "other"\n',
    );

    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
    expect(second.issues.map((issue) => issue.code)).toEqual(['toml-section-exists']);
  });
});

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

describe('json writer', () => {
  it('replaces arrays instead of concatenating them', () => {
    // Concatenating `args` would append `-y coolify-mcp` again on every install.
    const source = JSON.stringify(
      { mcpServers: { coolify: { args: ['-y', 'coolify-mcp@0.9.0'] } } },
      null,
      2,
    );

    const result = mergeJson(source, KEY_PATH, ENTRY);

    expect(JSON.parse(result.text).mcpServers.coolify.args).toEqual(['-y', 'coolify-mcp@1.4.2']);
  });

  it('keeps key order, so re-serialising a file we wrote reproduces it', () => {
    const source = `${JSON.stringify({ z: 1, mcpServers: { other: {} }, a: 2 }, null, 2)}\n`;

    const result = mergeJson(source, KEY_PATH, ENTRY);

    expect(Object.keys(JSON.parse(result.text))).toEqual(['z', 'mcpServers', 'a']);
    expect(Object.keys(JSON.parse(result.text).mcpServers)).toEqual(['other', 'coolify']);
  });

  it('refuses when the key path runs through a non-object', () => {
    const result = mergeJson('{"mcpServers": "not an object"}', KEY_PATH, ENTRY);

    expect(errorCodes(result.issues)).toEqual(['json-key-path-conflict']);
    expect(result.changed).toBe(false);
  });

  it('refuses a document whose root is not an object', () => {
    const result = mergeJson('[1, 2, 3]', KEY_PATH, ENTRY);

    expect(errorCodes(result.issues)).toEqual(['json-root-not-object']);
  });

  it('treats an empty file as {} rather than as corrupt', () => {
    // A client that created the file but never wrote a server into it is normal.
    const result = mergeJson('   \n', KEY_PATH, ENTRY);

    expect(result.changed).toBe(true);
    expect(JSON.parse(result.text).mcpServers.coolify).toEqual(ENTRY);
  });

  it('round-trips a BOM, CRLF and tab indentation', () => {
    const source = `${BOM}{\r\n\t"mcpServers": {}\r\n}\r\n`;

    const result = mergeJson(source, KEY_PATH, ENTRY);

    expect(result.text.startsWith(BOM)).toBe(true);
    expect(result.text).toContain('\r\n');
    expect(result.text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(result.text).toContain('\t"mcpServers"');
  });

  it('takes the smallest indent in the file, not the first one it sees', () => {
    const source = '{\n  "a": {\n        "deeply": 1\n  }\n}\n';

    const result = mergeJson(source, KEY_PATH, ENTRY);

    expect(result.text).toContain('\n  "mcpServers"');
  });

  it('prunes a container our removal emptied, but never the root', () => {
    const installed = mergeJson('{}\n', KEY_PATH, ENTRY);

    const removed = removeJson(installed.text, KEY_PATH);

    expect(JSON.parse(removed.text)).toEqual({});
  });

  it('keeps a container that still holds somebody else', () => {
    const source = `${JSON.stringify({ mcpServers: { other: { command: 'x' }, coolify: ENTRY } }, null, 2)}\n`;

    const removed = removeJson(source, KEY_PATH);

    expect(JSON.parse(removed.text)).toEqual({ mcpServers: { other: { command: 'x' } } });
  });

  it('leaves an empty container alone when the caller says it was already there', () => {
    const removed = removeJson(
      `${JSON.stringify({ mcpServers: { coolify: ENTRY } }, null, 2)}\n`,
      KEY_PATH,
      {
        pruneEmpty: false,
      },
    );

    expect(JSON.parse(removed.text)).toEqual({ mcpServers: {} });
  });

  it('does nothing when the entry is not there', () => {
    const source = '{"other": 1}\n';

    expect(removeJson(source, KEY_PATH).text).toBe(source);
  });
});

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

describe('jsonc writer', () => {
  it('keeps a comment that sits inside our own entry', () => {
    const source = [
      '{',
      '  "mcpServers": {',
      '    "coolify": {',
      '      // pinned by hand',
      '      "command": "npx"',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');

    const result = mergeJsonc(source, KEY_PATH, ENTRY);

    expect(result.text).toContain('// pinned by hand');
    expect(result.text).toContain('coolify-mcp@1.4.2');
  });

  it('edits only the values that moved', () => {
    const source = [
      '{',
      '  "mcpServers": {',
      '    "coolify": {',
      '      "command": "npx",',
      '      "args": ["-y", "coolify-mcp@0.9.0"]',
      '    }',
      '  },',
      '  "theme": "One Dark" // kept',
      '}',
      '',
    ].join('\n');

    const result = mergeJsonc(source, KEY_PATH, ENTRY);

    expect(result.text).toContain('"theme": "One Dark" // kept');
    expect(result.text).toContain('coolify-mcp@1.4.2');
    expect(result.text).not.toContain('0.9.0');
  });

  it('keeps a comment that sat above our entry when removing it', () => {
    // `isPrunable` exists to protect exactly this: a container whose braces wrap
    // nothing but a comment parses as empty, and deleting it throws away
    // something a human wrote. The protection only works if the comment is still
    // there to see once our property is gone.
    const source = [
      '{',
      '  "mcpServers": {',
      '    // add servers here',
      '    "coolify": { "command": "npx" }',
      '  }',
      '}',
      '',
    ].join('\n');

    const removed = removeJsonc(source, KEY_PATH);

    expect(removed.text).toContain('// add servers here');
  });

  it('leaves a file that still parses when a comment sat below our entry', () => {
    // The worst outcome the installer can produce is a client config that no
    // longer loads. Removing a property whose trailing comma is followed by a
    // comment must not leave the comma behind: `{ , // note }` is not JSONC, and
    // a Zed settings.json in that state loses every setting in it, not just ours.
    const source = [
      '{',
      '  "mcpServers": {',
      '    "coolify": { "command": "npx" },',
      '    // add servers here',
      '  }',
      '}',
      '',
    ].join('\n');

    const removed = removeJsonc(source, KEY_PATH);

    expect(removed.text).not.toMatch(/\{\s*,/);
    const errors: ParseError[] = [];
    parseJsonc(removed.text, errors, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: true,
    });
    expect(
      errors,
      `removeJsonc produced unparseable JSONC: ${JSON.stringify(removed.text)}`,
    ).toEqual([]);
  });

  it('reports an error instead of writing bytes that do not parse', () => {
    // Belt and braces on the same failure: even if a writer produced broken
    // text, `issues` is the channel apply() checks before writing, so a silent
    // `issues: []` on corrupt output is a second, independent defect.
    const source = [
      '{',
      '  "mcpServers": {',
      '    "coolify": { "command": "npx" },',
      '    // add servers here',
      '  }',
      '}',
      '',
    ].join('\n');

    const removed = removeJsonc(source, KEY_PATH);
    const errors: ParseError[] = [];
    parseJsonc(removed.text, errors, {
      allowTrailingComma: true,
      disallowComments: false,
      allowEmptyContent: true,
    });

    if (errors.length > 0) {
      expect(
        errorCodes(removed.issues).length,
        'unparseable output was reported as a clean success',
      ).toBeGreaterThan(0);
    }
  });

  it('reports the line and column of a syntax error', () => {
    const result = mergeJsonc('{\n  "a": 1,\n  "b" 2\n}\n', KEY_PATH, ENTRY);

    expect(errorCodes(result.issues)).toEqual(['jsonc-unparseable']);
    expect(result.issues[0]?.message).toMatch(/line \d+, column \d+/);
  });

  it('refuses a root that is not an object', () => {
    const result = mergeJsonc('"just a string"', KEY_PATH, ENTRY);

    expect(errorCodes(result.issues)).toEqual(['jsonc-root-not-object']);
  });
});

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

describe('toml writer', () => {
  const SECTION = 'mcp_servers.coolify';
  const BLOCK = '[mcp_servers.coolify]\ncommand = "npx"\nargs = ["-y", "coolify-mcp@1.4.2"]\n';

  it('appends without re-emitting a single byte it did not author', () => {
    const source = '# Codex\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';

    const result = appendTomlSection(source, SECTION, BLOCK);

    expect(result.text.startsWith(source)).toBe(true);
    expect(result.text).toContain('[mcp_servers.coolify]');
  });

  it('never re-declares the parent table', () => {
    // `[mcp_servers]` appearing twice is a duplicate-table error that would take
    // the user's whole config down.
    const result = appendTomlSection('[mcp_servers.other]\ncommand = "other"\n', SECTION, BLOCK);

    expect(result.text.match(/^\[mcp_servers\]$/gm)).toBeNull();
  });

  it('rewrites in place under --update and leaves the neighbours alone', () => {
    const source =
      '[mcp_servers.coolify]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "other"\n';

    const result = replaceTomlSection(source, SECTION, BLOCK);

    expect(result.text).toContain('coolify-mcp@1.4.2');
    expect(result.text).not.toContain('command = "old"');
    expect(result.text).toContain('[mcp_servers.other]\ncommand = "other"\n');
  });

  it('appends when --update finds nothing to replace', () => {
    const result = replaceTomlSection('model = "gpt-5"\n', SECTION, BLOCK);

    expect(result.text).toContain('[mcp_servers.coolify]');
  });

  it('restores the exact pre-install bytes on removal', () => {
    const source = '# Codex\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';

    const installed = appendTomlSection(source, SECTION, BLOCK);
    const removed = removeTomlSection(installed.text, SECTION);

    expect(removed.text).toBe(source);
  });

  it('removes sub-tables along with the section', () => {
    const source =
      '[mcp_servers.coolify]\ncommand = "npx"\n\n[mcp_servers.coolify.env]\nA = "b"\n\n[mcp_servers.other]\ncommand = "other"\n';

    const removed = removeTomlSection(source, SECTION);

    expect(removed.text).not.toContain('coolify');
    expect(removed.text).toContain('[mcp_servers.other]');
  });

  it('is not fooled by a [ inside a multi-line array', () => {
    // The scanner has to skip these; treating one as a table header would make
    // the section span the wrong region and delete somebody else's config.
    const source = [
      'model = "gpt-5"',
      'paths = [',
      '  "[not-a-header]",',
      '  "b",',
      ']',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
    ].join('\n');

    const installed = appendTomlSection(source, SECTION, BLOCK);
    const removed = removeTomlSection(installed.text, SECTION);

    expect(removed.text).toBe(source);
    expect(removed.text).toContain('"[not-a-header]"');
  });

  it('is not fooled by a [ inside a multi-line string', () => {
    const source = [
      'banner = """',
      '[mcp_servers.coolify]',
      'this is prose, not a table',
      '"""',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
    ].join('\n');

    const doc = parseTomlDocument(source);
    expect(doc.issue).toBeUndefined();
    // The header inside the string must not register as our section.
    expect(hasTomlSection(doc.table, SECTION)).toBe(false);

    const result = appendTomlSection(source, SECTION, BLOCK);
    expect(result.changed).toBe(true);
    expect(result.text.startsWith(source)).toBe(true);
  });

  it('reports an unparseable file under the code the adapter documents', () => {
    const result = appendTomlSection('model = \n', SECTION, BLOCK);

    expect(errorCodes(result.issues)).toEqual(['codex-config-unparseable']);
  });

  it('does nothing when the section is not there', () => {
    const source = 'model = "gpt-5"\n';

    expect(removeTomlSection(source, SECTION).text).toBe(source);
  });

  it('splits dotted keys, honouring quoting', () => {
    expect(splitDottedKey('mcp_servers."my.server".env')).toEqual([
      'mcp_servers',
      'my.server',
      'env',
    ]);
    expect(splitDottedKey('a.b.c')).toEqual(['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// YAML — no adapter writes through this yet, which is exactly why it is here
// ---------------------------------------------------------------------------

describe('yaml writer', () => {
  const YAML_PATH = ['mcp', 'coolify'];
  const YAML_ENTRY = { type: 'local', command: ['npx', '-y', 'coolify-mcp@1.4.2'], enabled: true };

  it('adds the entry to an existing map', () => {
    const source = 'defaultModel: minimax/abab-6.5\nmcp:\n  other:\n    type: local\n';

    const result = mergeYaml(source, YAML_PATH, YAML_ENTRY);

    expect(result.changed).toBe(true);
    expect(result.text).toContain('coolify:');
    expect(result.text).toContain('coolify-mcp@1.4.2');
    expect(result.text).toContain('other:');
  });

  it('keeps comments, which a parse/stringify round trip destroys', () => {
    const source = [
      '# MiniMax configuration',
      'defaultModel: minimax/abab-6.5 # the fast one',
      '',
      '# servers',
      'mcp:',
      '  other:',
      '    type: local',
      '',
    ].join('\n');

    const result = mergeYaml(source, YAML_PATH, YAML_ENTRY);

    expect(result.text).toContain('# MiniMax configuration');
    expect(result.text).toContain('# the fast one');
    expect(result.text).toContain('# servers');
  });

  it('keeps anchors and aliases instead of expanding them into duplicates', () => {
    const source = [
      'defaults: &defaults',
      '  type: local',
      '  enabled: true',
      'mcp:',
      '  other: *defaults',
      '',
    ].join('\n');

    const result = mergeYaml(source, YAML_PATH, YAML_ENTRY);

    expect(result.text).toContain('&defaults');
    expect(result.text).toContain('*defaults');
  });

  it('does not fold a long value across lines', () => {
    // Folding is valid YAML that nobody wants to read in a diff, and it makes
    // the entry hard to match by eye against the docs.
    const long = { command: ['npx', '-y', 'coolify-mcp@1.4.2', '--flag', 'a'.repeat(120)] };

    const result = mergeYaml('mcp: {}\n', YAML_PATH, long);

    expect(result.text).toContain('a'.repeat(120));
  });

  it('replaces an array rather than appending to it', () => {
    const source =
      'mcp:\n  coolify:\n    command:\n      - npx\n      - "-y"\n      - coolify-mcp@0.9.0\n';

    const result = mergeYaml(source, YAML_PATH, YAML_ENTRY);

    expect(result.text).toContain('coolify-mcp@1.4.2');
    expect(result.text).not.toContain('0.9.0');
  });

  it('creates the whole path when the file is empty', () => {
    const result = mergeYaml('', YAML_PATH, YAML_ENTRY);

    expect(result.text).toContain('mcp:');
    expect(result.text).toContain('coolify:');
  });

  it('prunes the container it emptied on removal, but not the root', () => {
    const installed = mergeYaml('', YAML_PATH, YAML_ENTRY);

    const removed = removeYaml(installed.text, YAML_PATH);

    expect(removed.text).not.toContain('coolify');
    expect(removed.text.trim()).not.toContain('mcp:');
  });

  it('leaves a container that still holds somebody else', () => {
    const source = 'mcp:\n  other:\n    type: local\n  coolify:\n    type: local\n';

    const removed = removeYaml(source, YAML_PATH);

    expect(removed.text).toContain('other:');
    expect(removed.text).not.toContain('coolify');
  });

  it('round-trips a BOM and CRLF', () => {
    const source = `${BOM}mcp:\r\n  other:\r\n    type: local\r\n`;

    const result = mergeYaml(source, YAML_PATH, YAML_ENTRY);

    expect(result.text.startsWith(BOM)).toBe(true);
    expect(result.text).toContain('\r\n');
    expect(result.text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('does nothing when the entry is not there', () => {
    const source = 'defaultModel: minimax/abab-6.5\n';

    expect(removeYaml(source, YAML_PATH).text).toBe(source);
  });

  it('install then remove restores the original bytes', () => {
    const source = [
      '# MiniMax configuration',
      'defaultModel: minimax/abab-6.5',
      'mcp:',
      '  other:',
      '    type: local',
      '',
    ].join('\n');

    const installed = mergeYaml(source, YAML_PATH, YAML_ENTRY);
    const removed = removeYaml(installed.text, YAML_PATH);

    expect(removed.text).toBe(source);
  });
});
