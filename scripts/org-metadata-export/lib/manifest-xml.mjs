function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * @param {Array<{type: string, members: string[]}>} typeGroups
 * @param {string} apiVersion
 */
export function buildPackageXml(typeGroups, apiVersion) {
  const typesXml = typeGroups
    .filter((g) => g.members.length > 0)
    .map((g) => {
      const membersXml = g.members.map((m) => `        <members>${escapeXml(m)}</members>`).join('\n');
      return `    <types>\n${membersXml}\n        <name>${escapeXml(g.type)}</name>\n    </types>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${typesXml}\n    <version>${escapeXml(apiVersion)}</version>\n</Package>\n`;
}
