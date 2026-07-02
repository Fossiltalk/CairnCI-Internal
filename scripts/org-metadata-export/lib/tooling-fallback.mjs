import { sfQuery } from './sf-cli.mjs';

// `sf org list metadata` (Metadata API listMetadata) silently caps at 3,000
// rows per call with no pagination. For types known to plausibly exceed that
// in a large org, query the Tooling/REST API instead, which supports normal
// SOQL pagination (the CLI's `sf data query` already pages internally).
// `buildMembers` returns manifest member names (the string that goes in
// package.xml <members>) from the raw query records.
const FALLBACKS = {
  ApexClass: {
    soql: 'SELECT Name FROM ApexClass',
    tooling: true,
    buildMembers: (rows) => rows.map((r) => r.Name),
  },
  ApexTrigger: {
    soql: 'SELECT Name FROM ApexTrigger',
    tooling: true,
    buildMembers: (rows) => rows.map((r) => r.Name),
  },
  ApexPage: {
    soql: 'SELECT Name FROM ApexPage',
    tooling: true,
    buildMembers: (rows) => rows.map((r) => r.Name),
  },
  ApexComponent: {
    soql: 'SELECT Name FROM ApexComponent',
    tooling: true,
    buildMembers: (rows) => rows.map((r) => r.Name),
  },
  StaticResource: {
    soql: 'SELECT Name FROM StaticResource',
    tooling: true,
    buildMembers: (rows) => rows.map((r) => r.Name),
  },
  PermissionSet: {
    soql: 'SELECT Name FROM PermissionSet WHERE IsOwnedByProfile = false',
    tooling: false,
    buildMembers: (rows) => rows.map((r) => r.Name),
  },
  Flow: {
    soql: 'SELECT DeveloperName FROM FlowDefinition',
    tooling: true,
    buildMembers: (rows) => rows.map((r) => r.DeveloperName),
  },
  LightningComponentBundle: {
    soql: 'SELECT DeveloperName FROM LightningComponentBundle',
    tooling: true,
    buildMembers: (rows) => rows.map((r) => r.DeveloperName),
  },
  AuraDefinitionBundle: {
    soql: 'SELECT DeveloperName FROM AuraDefinitionBundle',
    tooling: true,
    buildMembers: (rows) => rows.map((r) => r.DeveloperName),
  },
  CustomField: {
    soql: "SELECT EntityDefinition.QualifiedApiName, QualifiedApiName FROM FieldDefinition WHERE QualifiedApiName LIKE '%__c'",
    tooling: true,
    buildMembers: (rows) => rows.map((r) => `${r.EntityDefinition.QualifiedApiName}.${r.QualifiedApiName}`),
  },
  Layout: {
    soql: 'SELECT Name, EntityDefinition.QualifiedApiName FROM Layout',
    tooling: true,
    buildMembers: (rows) => rows.map((r) => `${r.EntityDefinition.QualifiedApiName}-${r.Name}`),
  },
  ValidationRule: {
    soql: 'SELECT ValidationName, EntityDefinition.QualifiedApiName FROM ValidationRule',
    tooling: true,
    buildMembers: (rows) => rows.map((r) => `${r.EntityDefinition.QualifiedApiName}.${r.ValidationName}`),
  },
};

export function hasFallback(xmlName) {
  return Object.prototype.hasOwnProperty.call(FALLBACKS, xmlName);
}

/**
 * Returns the full, un-truncated member list for a type via Tooling/REST API
 * SOQL, or null if no fallback is registered for that type.
 */
export async function fetchFullMemberList(targetOrg, xmlName) {
  const fallback = FALLBACKS[xmlName];
  if (!fallback) return null;
  const rows = await sfQuery(targetOrg, fallback.soql, { toolingApi: fallback.tooling });
  return fallback.buildMembers(rows);
}

export const FALLBACK_TYPES = Object.keys(FALLBACKS);
