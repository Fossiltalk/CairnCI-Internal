import { sfDescribeMetadata } from './sf-cli.mjs';

/**
 * Returns the set of metadata types that are directly listable via
 * `sf org list metadata`, excluding types that only ever appear as a child
 * of another type (e.g. CustomLabel under CustomLabels, WorkflowAlert under
 * Workflow) — those are retrieved automatically with their parent and
 * listMetadata calls against them return nothing useful.
 */
export async function getListableTypes(targetOrg, apiVersion) {
  const described = await sfDescribeMetadata(targetOrg, apiVersion);
  const allTypes = described.metadataObjects ?? [];

  const childTypeNames = new Set();
  for (const t of allTypes) {
    for (const child of t.childXmlNames ?? []) {
      childTypeNames.add(child);
    }
  }

  const listable = allTypes.filter((t) => !childTypeNames.has(t.xmlName));
  const skipped = allTypes.filter((t) => childTypeNames.has(t.xmlName)).map((t) => t.xmlName);

  return { listable, skipped, organizationNamespace: described.organizationNamespace };
}
