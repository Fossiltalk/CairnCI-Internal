// Shared test fixtures: a stub `sf` client and a throwaway git repo.
// Nothing here talks to Salesforce, the network, or a real `sf` CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSfClient } from '../lib/sf-cli.mjs';

/**
 * Builds a stub sf client from a declarative org description.
 *
 * @param {object} org
 * @param {string} [org.id]
 * @param {string} [org.apiVersion]
 * @param {Record<string, string[]>} org.types     xmlName -> member fullNames
 * @param {string[]} [org.childTypes]              types that are children of others
 * @param {Record<string, string>} [org.listErrors] xmlName -> error message thrown by listMetadata
 * @param {(manifestPath: string, outputDir: string) => void} [org.onRetrieve]
 *        throw to simulate a failed retrieve; the thrown message is what the
 *        retrieve phase pattern-matches
 */
export function makeStubSf(org) {
  const calls = { listMetadata: [], retrieve: [], convertMdapi: [], query: [] };

  const client = createSfClient({
    run: async () => {
      throw new Error('stub sf client should never reach the real CLI');
    },
  });

  const stub = {
    ...client,
    calls,

    async orgDisplay() {
      return { id: org.id ?? '00D000000000000AAA', apiVersion: org.apiVersion ?? '62.0' };
    },

    async describeMetadata() {
      const childTypes = org.childTypes ?? [];
      const metadataObjects = Object.keys(org.types).map((xmlName) => ({ xmlName, childXmlNames: [] }));
      // A child-only type is expressed as some other type declaring it.
      if (childTypes.length > 0) {
        metadataObjects.push({ xmlName: '__parent__', childXmlNames: childTypes });
        for (const c of childTypes) metadataObjects.push({ xmlName: c, childXmlNames: [] });
      }
      return { metadataObjects, organizationNamespace: '' };
    },

    async listMetadata(targetOrg, type, opts = {}) {
      calls.listMetadata.push({ type, ...opts });
      if (org.listErrors?.[type]) throw new Error(org.listErrors[type]);
      // Folder-scoped listing: `folderMembers` maps "<Type>/<folder>" to its
      // members, so a test can model the unfiled$public pseudo-folder.
      if (opts.folder) {
        const key = `${type}/${opts.folder}`;
        return (org.folderMembers?.[key] ?? []).map((fullName) => ({
          fullName,
          lastModifiedDate: '2026-01-01T00:00:00.000Z',
        }));
      }
      return (org.types[type] ?? []).map((fullName) => ({ fullName, lastModifiedDate: '2026-01-01T00:00:00.000Z' }));
    },

    async query(targetOrg, soql) {
      calls.query.push(soql);
      if (/FROM Folder/.test(soql)) return org.folders ?? [];
      return org.queryRows ?? [];
    },

    async retrieve(targetOrg, manifestPath, outputDir) {
      calls.retrieve.push({ manifestPath, outputDir });
      if (org.onRetrieve) org.onRetrieve(manifestPath, outputDir);
      // Lay down the mdapi shape the retrieve phase expects to convert.
      fs.mkdirSync(path.join(outputDir, 'unpackaged', 'unpackaged'), { recursive: true });
      return {};
    },

    async convertMdapi(rootDir, outputDir) {
      calls.convertMdapi.push({ rootDir, outputDir });
      // Stand in for the real conversion: write one file per retrieve so the
      // git-facing tests have something to commit.
      const dir = path.join(outputDir, 'main', 'default', 'classes');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `Converted${calls.convertMdapi.length}.cls`), 'public class C {}');
      return {};
    },
  };

  return stub;
}

/** Builds an index object of the shape runIndexPhase writes. */
export function makeIndex(types, extra = {}) {
  return {
    runId: '20260726-000000',
    targetOrg: 'test-org',
    orgId: '00D000000000000AAA',
    apiVersion: '62.0',
    generatedAt: '2026-07-26T00:00:00.000Z',
    totalComponents: Object.values(types).reduce((n, m) => n + m.length, 0),
    skippedChildTypes: [],
    truncatedUnresolvedTypes: [],
    erroredTypes: [],
    types: Object.fromEntries(
      Object.entries(types).map(([type, members]) => [
        type,
        { count: members.length, truncated: false, fallback: 'none', members: members.map((fullName) => ({ fullName })) },
      ]),
    ),
    ...extra,
  };
}

export function tempDir(prefix = 'rom-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr || res.stdout}`);
  return (res.stdout ?? '').trim();
}

/**
 * A git repo with one commit and a `force-app/main/default` tree, plus a bare
 * repo wired up as `origin` so push paths are exercised for real.
 */
export function makeRepo({ withOrigin = true } = {}) {
  const dir = tempDir();
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  git(['init', '-q', '-b', 'main'], cwd);
  git(['config', 'user.email', 'ci@example.com'], cwd);
  git(['config', 'user.name', 'CI'], cwd);

  const classes = path.join(cwd, 'force-app', 'main', 'default', 'classes');
  fs.mkdirSync(classes, { recursive: true });
  fs.writeFileSync(path.join(classes, 'Existing.cls'), 'public class Existing {}');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# fixture\n');
  git(['add', '-A'], cwd);
  git(['commit', '-qm', 'base'], cwd);

  let origin = null;
  if (withOrigin) {
    origin = path.join(dir, 'origin.git');
    git(['init', '-q', '--bare', origin], dir);
    git(['remote', 'add', 'origin', origin], cwd);
  }

  return { root: dir, cwd, origin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
