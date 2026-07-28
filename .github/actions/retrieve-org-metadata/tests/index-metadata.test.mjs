import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runIndexPhase, LISTMETADATA_TRUNCATION_LIMIT } from '../lib/index-metadata.mjs';
import { runPaths } from '../lib/paths.mjs';
import { makeStubSf, tempDir } from './helpers.mjs';

const dirs = [];
function runDir() {
  const d = path.join(tempDir(), '20260726-041500');
  fs.mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(path.dirname(dirs.pop()), { recursive: true, force: true });
});

const quiet = { log: () => {}, warn: () => {} };

describe('index phase', () => {
  test('builds a per-type index with counts from listMetadata', async () => {
    const sf = makeStubSf({
      types: {
        ApexClass: ['Alpha', 'Beta', 'Gamma'],
        CustomObject: ['Widget__c'],
        PermissionSet: [],
      },
    });

    const { index } = await runIndexPhase({ sf, targetOrg: 'test-org', runDir: runDir(), ...quiet });

    assert.equal(index.types.ApexClass.count, 3);
    assert.equal(index.types.CustomObject.count, 1);
    assert.equal(index.types.PermissionSet.count, 0);
    assert.equal(index.totalComponents, 4);
    assert.deepEqual(
      index.types.ApexClass.members.map((m) => m.fullName),
      ['Alpha', 'Beta', 'Gamma'],
    );
    assert.equal(index.apiVersion, '62.0');
    assert.equal(index.orgId, '00D000000000000AAA');
  });

  test('writes the index and a per-type count summary to disk', async () => {
    const dir = runDir();
    const sf = makeStubSf({ types: { ApexClass: ['Alpha'], Flow: ['Onboard', 'Offboard'] } });

    await runIndexPhase({ sf, targetOrg: 'test-org', runDir: dir, ...quiet });

    const paths = runPaths(dir);
    const onDisk = JSON.parse(fs.readFileSync(paths.indexFile, 'utf8'));
    assert.equal(onDisk.totalComponents, 3);

    const summary = fs.readFileSync(paths.summaryFile, 'utf8');
    assert.match(summary, /\| Flow \| 2 \|/);
    assert.match(summary, /\| ApexClass \| 1 \|/);
    assert.match(summary, /Total components: \*\*3\*\*/);
  });

  test('skips child-only types that come back with their parent', async () => {
    const sf = makeStubSf({ types: { Workflow: ['Account'] }, childTypes: ['WorkflowAlert', 'WorkflowRule'] });

    const { index } = await runIndexPhase({ sf, targetOrg: 'test-org', runDir: runDir(), ...quiet });

    assert.ok(!('WorkflowAlert' in index.types), 'child type must not be listed independently');
    assert.ok(index.skippedChildTypes.includes('WorkflowAlert'));
    assert.ok(index.skippedChildTypes.includes('WorkflowRule'));
  });

  test('records a type whose listMetadata call fails instead of aborting the index', async () => {
    const sf = makeStubSf({
      types: { ApexClass: ['Alpha'], SketchyType: [] },
      listErrors: { SketchyType: 'INSUFFICIENT_ACCESS: cannot list SketchyType' },
    });

    const { index } = await runIndexPhase({ sf, targetOrg: 'test-org', runDir: runDir(), ...quiet });

    assert.equal(index.types.ApexClass.count, 1, 'other types still indexed');
    assert.equal(index.types.SketchyType.fallback, 'error');
    assert.match(index.types.SketchyType.error, /INSUFFICIENT_ACCESS/);
    assert.deepEqual(
      index.erroredTypes.map((e) => e.type),
      ['SketchyType'],
    );
  });

  test('flags a type truncated at the 3,000-row cap with no Tooling fallback', async () => {
    // CustomMetadata has no registered fallback; exactly 3,000 rows is how the
    // API signals truncation (there is no error and no pagination).
    const members = Array.from({ length: LISTMETADATA_TRUNCATION_LIMIT }, (_, i) => `Rec_${i}`);
    const sf = makeStubSf({ types: { CustomMetadata: members } });

    const { index } = await runIndexPhase({ sf, targetOrg: 'test-org', runDir: runDir(), ...quiet });

    assert.equal(index.types.CustomMetadata.truncated, true);
    assert.equal(index.types.CustomMetadata.fallback, 'unavailable');
    assert.deepEqual(index.truncatedUnresolvedTypes, ['CustomMetadata']);
  });

  test('recovers a truncated high-volume type through the Tooling API fallback', async () => {
    const members = Array.from({ length: LISTMETADATA_TRUNCATION_LIMIT }, (_, i) => `Cls_${i}`);
    const sf = makeStubSf({ types: { ApexClass: members } });
    // ApexClass HAS a fallback: the SOQL path returns the full, larger list.
    sf.query = async () => Array.from({ length: 3200 }, (_, i) => ({ Name: `Cls_${i}` }));

    const { index } = await runIndexPhase({ sf, targetOrg: 'test-org', runDir: runDir(), ...quiet });

    assert.equal(index.types.ApexClass.fallback, 'tooling');
    assert.equal(index.types.ApexClass.count, 3200);
    assert.deepEqual(index.truncatedUnresolvedTypes, []);
  });

  // Regression: org-verified against CairnCI_Production. The org had ZERO
  // Folder rows of Type='Email' but 42 EmailTemplates, all in the
  // unfiled$public pseudo-folder — which has no Folder record, so discovering
  // folders by SOQL alone silently indexed none of them.
  test('indexes the unfiled$public pseudo-folder, which has no Folder record', async () => {
    const sf = makeStubSf({
      types: { EmailTemplate: [], Report: [] },
      // The Folder object knows about one report folder and no email folders.
      folders: [{ DeveloperName: 'SalesReports', Type: 'Report' }],
      folderMembers: {
        'Report/SalesReports': ['SalesReports/Pipeline'],
        'Report/unfiled$public': ['unfiled$public/SampleReportofContacts'],
        'EmailTemplate/unfiled$public': ['unfiled$public/CommunityWelcome', 'unfiled$public/ContactFollowUp'],
      },
    });

    const { index } = await runIndexPhase({ sf, targetOrg: 'test-org', runDir: runDir(), ...quiet });

    assert.equal(index.types.EmailTemplate.count, 2, 'templates in unfiled$public must not be silently dropped');
    assert.equal(index.types.Report.count, 2, 'unfiled$public reports come in alongside real folders');
    assert.deepEqual(
      index.types.EmailTemplate.members.map((m) => m.fullName).sort(),
      ['unfiled$public/CommunityWelcome', 'unfiled$public/ContactFollowUp'],
    );

    // unfiled$public must be probed for every folder-based type present.
    const probed = sf.calls.listMetadata.filter((c) => c.folder === 'unfiled$public').map((c) => c.type);
    assert.ok(probed.includes('EmailTemplate'));
    assert.ok(probed.includes('Report'));
  });

  test('does not probe unfiled$public twice when the Folder object also names it', async () => {
    const sf = makeStubSf({
      types: { Report: [] },
      folders: [{ DeveloperName: 'unfiled$public', Type: 'Report' }],
      folderMembers: { 'Report/unfiled$public': ['unfiled$public/OnlyOnce'] },
    });

    const { index } = await runIndexPhase({ sf, targetOrg: 'test-org', runDir: runDir(), ...quiet });

    assert.equal(index.types.Report.count, 1, 'a duplicated folder would double-count its members');
    assert.equal(sf.calls.listMetadata.filter((c) => c.folder === 'unfiled$public').length, 1);
  });

  // Regression: org-verified against CairnCI_Production. listMetadata returned
  // 814 CustomObject rows for 813 distinct objects — two byte-identical
  // `Account` entries, nothing to tell them apart. Left in, the duplicate
  // reaches package.xml as a repeated <members> entry and inflates counts.
  test('deduplicates members that listMetadata returns more than once', async () => {
    const sf = makeStubSf({
      types: { CustomObject: ['Account', 'Contact', 'Account', 'Widget__c'] },
    });

    const { index } = await runIndexPhase({ sf, targetOrg: 'test-org', runDir: runDir(), ...quiet });

    assert.equal(index.types.CustomObject.count, 3, 'the duplicate must not be counted twice');
    assert.deepEqual(
      index.types.CustomObject.members.map((m) => m.fullName),
      ['Account', 'Contact', 'Widget__c'],
      'first occurrence is kept, order otherwise preserved',
    );
    assert.equal(index.types.CustomObject.duplicatesDropped, 1, 'the drop is recorded, not silent');
    assert.equal(index.totalComponents, 3);
  });

  test('deduplicates across folders, where merged results collide most easily', async () => {
    const sf = makeStubSf({
      types: { Report: [] },
      folders: [{ DeveloperName: 'Shared', Type: 'Report' }],
      folderMembers: {
        'Report/Shared': ['Shared/Pipeline', 'Shared/Pipeline'],
        'Report/unfiled$public': ['unfiled$public/Adhoc'],
      },
    });

    const { index } = await runIndexPhase({ sf, targetOrg: 'test-org', runDir: runDir(), ...quiet });

    assert.equal(index.types.Report.count, 2);
    assert.equal(index.types.Report.duplicatesDropped, 1);
  });

  test('requires an sf client and a target org', async () => {
    await assert.rejects(() => runIndexPhase({ targetOrg: 'o', runDir: runDir() }), /sf client is required/);
    await assert.rejects(
      () => runIndexPhase({ sf: makeStubSf({ types: {} }), runDir: runDir() }),
      /targetOrg is required/,
    );
  });
});
