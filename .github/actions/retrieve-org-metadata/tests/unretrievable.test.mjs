import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyFailure,
  collectFindings,
  loadKnownUnretrievable,
  buildUnretrievableSummary,
  UNKNOWN_GUIDANCE,
} from '../lib/unretrievable.mjs';
import { makeIndex } from './helpers.mjs';

const ACTION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const known = loadKnownUnretrievable();

describe('known-unretrievable.json', () => {
  test('is valid JSON and ships with the action', () => {
    const file = path.join(ACTION_DIR, 'known-unretrievable.json');
    assert.ok(fs.existsSync(file), 'reference data must be tracked in the branch');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
  });

  test('every entry carries a category, reason, workaround and source', () => {
    const categories = new Set(Object.keys(known.categories));
    assert.ok(categories.size > 0);

    for (const [type, entry] of Object.entries(known.types)) {
      assert.ok(entry.reason, `${type} needs a reason`);
      assert.ok(entry.workaround, `${type} needs a workaround`);
      assert.ok(entry.source, `${type} needs a source — unsourced entries must not ship`);
      assert.ok(categories.has(entry.category), `${type} has unknown category ${entry.category}`);
      assert.ok(['observed', 'docs'].includes(entry.verified), `${type} needs verified: observed|docs`);
    }
  });

  test('points at the canonical Salesforce unsupported-types list', () => {
    assert.match(known.canonicalDocs.unsupportedMetadataTypes, /developer\.salesforce\.com/);
  });
});

describe('failure classification', () => {
  test('classifies a known-unretrievable type from known-unretrievable.json', () => {
    const result = classifyFailure('StandardValueSet', 'listMetadata returned 0 rows', known);

    assert.equal(result.known, true);
    assert.equal(result.category, 'api-limitation');
    assert.match(result.reason, /listMetadata returns zero rows/);
    assert.match(result.workaround, /explicit package\.xml|hand-maintained manifest/);
    assert.match(result.source, /^https:\/\//);
  });

  test('classifies an unrecognised failure as permissions-or-undocumented', () => {
    const result = classifyFailure('MysteryType__x', 'INSUFFICIENT_ACCESS: no permission', known);

    assert.equal(result.known, false);
    assert.equal(result.category, 'unknown');
    assert.equal(result.workaround, UNKNOWN_GUIDANCE);
    assert.match(result.workaround, /permission/i);
    assert.match(result.workaround, /undocumented/i);
    assert.equal(result.source, null);
    assert.match(result.error, /INSUFFICIENT_ACCESS/);
  });

  test('classifies the observed sf CLI registry gap as a known cli-registry-gap', () => {
    const result = classifyFailure('IdentityVerificationProcDtl', undefined, known);
    assert.equal(result.known, true);
    assert.equal(result.category, 'cli-registry-gap');
    assert.match(result.workaround, /upgrade @salesforce\/cli/i);
  });

  test('falls back to unknown when the reference file is missing rather than throwing', () => {
    const empty = loadKnownUnretrievable('/nonexistent/known-unretrievable.json');
    assert.deepEqual(empty.types, {});
    assert.equal(classifyFailure('StandardValueSet', 'boom', empty).known, false);
  });
});

describe('collecting findings across phases', () => {
  test('collects failures from both the index and the retrieve phases', () => {
    const index = makeIndex(
      { ApexClass: ['Alpha'] },
      {
        erroredTypes: [{ type: 'MysteryType__x', error: 'INSUFFICIENT_ACCESS' }],
        truncatedUnresolvedTypes: ['CustomMetadata'],
      },
    );
    const report = {
      chunks: [
        { file: 'package-chunk-001.xml', status: 'succeeded', excludedTypes: ['IdentityVerificationProcDtl'] },
        { file: 'package-chunk-002.xml', status: 'failed', error: 'timed out after 60m' },
      ],
    };

    const result = collectFindings({ index, report, known });
    const types = result.findings.map((f) => f.type).sort();

    assert.deepEqual(types, ['CustomMetadata', 'IdentityVerificationProcDtl', 'MysteryType__x']);
    assert.equal(result.knownCount, 2, 'CustomMetadata + IdentityVerificationProcDtl are documented');
    assert.equal(result.unknownCount, 1, 'MysteryType__x is not');
    assert.equal(result.failedChunks.length, 1);
    assert.equal(result.failedChunks[0].file, 'package-chunk-002.xml');
  });

  test('reports nothing when every type came back', () => {
    const result = collectFindings({
      index: makeIndex({ ApexClass: ['Alpha'] }),
      report: { chunks: [{ file: 'package-chunk-001.xml', status: 'succeeded', excludedTypes: [] }] },
      known,
    });
    assert.equal(result.findings.length, 0);
    assert.equal(result.failedChunks.length, 0);
  });

  test('does not double-report a type that failed in more than one place', () => {
    const index = makeIndex({}, { erroredTypes: [{ type: 'CustomMetadata', error: 'x' }], truncatedUnresolvedTypes: ['CustomMetadata'] });
    const result = collectFindings({ index, report: { chunks: [] }, known });
    assert.equal(result.findings.length, 1);
  });
});

describe('job summary rendering', () => {
  test('separates expected limitations from unexplained failures', () => {
    const findings = collectFindings({
      index: makeIndex({}, { erroredTypes: [{ type: 'MysteryType__x', error: 'INSUFFICIENT_ACCESS: nope' }], truncatedUnresolvedTypes: ['CustomMetadata'] }),
      report: { chunks: [{ file: 'package-chunk-007.xml', status: 'failed', error: 'timed out' }] },
      known,
    });

    const md = buildUnretrievableSummary(findings, known.canonicalDocs);

    assert.match(md, /#### Expected \(1\)/);
    assert.match(md, /#### Unexplained \(1\)/);
    assert.match(md, /#### Failed chunks \(1\)/);
    assert.match(md, /`CustomMetadata`/);
    assert.match(md, /`MysteryType__x`/);
    assert.match(md, /package-chunk-007\.xml/);
    assert.match(md, /developer\.salesforce\.com/);
  });

  test('says so plainly when nothing was unretrievable', () => {
    const md = buildUnretrievableSummary({ findings: [], failedChunks: [] }, {});
    assert.match(md, /None — every indexed type was attempted and retrieved/);
  });

  test('escapes pipes and newlines so the markdown table survives', () => {
    const findings = {
      findings: [{ type: 'T', known: false, error: 'a | b\n  c', reason: 'r', workaround: 'w', source: null }],
      failedChunks: [],
    };
    const md = buildUnretrievableSummary(findings, {});
    const row = md.split('\n').find((l) => l.startsWith('| `T`'));
    assert.ok(row.includes('a \\| b c'), `pipe/newline not escaped in: ${row}`);
  });

  // CodeQL js/incomplete-sanitization. Escaping the pipe alone lets a trailing
  // backslash in the input pair with the one we add ("\" + "|" -> "\\|"), which
  // Markdown reads as an escaped backslash followed by a LIVE delimiter — the
  // row breaks anyway. The backslash must be escaped first.
  test('escapes backslashes before pipes, so a trailing backslash cannot free the delimiter', () => {
    const findings = {
      findings: [{ type: 'T', known: false, error: 'before \\| after', reason: 'r', workaround: 'w', source: null }],
      failedChunks: [],
    };
    const md = buildUnretrievableSummary(findings, {});
    const row = md.split('\n').find((l) => l.startsWith('| `T`'));

    assert.ok(row.includes('before \\\\\\| after'), `backslash not escaped first in: ${row}`);
    // The row must still have exactly the 3 delimiters of a 3-column table:
    // any unescaped pipe from the payload would add a fourth cell.
    const liveDelimiters = row.replace(/\\\\/g, '').split(/(?<!\\)\|/).length - 1;
    assert.equal(liveDelimiters, 3, `payload broke out into extra cells: ${row}`);
  });

  // CodeQL js/polynomial-redos. `\s*\n\s*` is ambiguous because \s matches \n,
  // so a long whitespace run backtracks quadratically. Guard the fix with a
  // payload big enough that a regression is unmissable rather than merely slow.
  test('collapses long whitespace runs in linear time (no polynomial backtracking)', () => {
    const payload = `x${' '.repeat(60000)}\n${' '.repeat(60000)}y`;
    const findings = {
      findings: [{ type: 'T', known: false, error: payload, reason: 'r', workaround: 'w', source: null }],
      failedChunks: [],
    };

    const started = Date.now();
    const md = buildUnretrievableSummary(findings, {});
    const elapsed = Date.now() - started;

    const row = md.split('\n').find((l) => l.startsWith('| `T`'));
    assert.ok(row.includes('x y'), `whitespace run not collapsed in: ${row.slice(0, 120)}`);
    assert.ok(elapsed < 1000, `took ${elapsed}ms — the regex is backtracking`);
  });
});
