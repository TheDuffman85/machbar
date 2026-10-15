// Print the CHANGELOG.md section of a version (default: the root package.json version).
//
//   node scripts/changelog.mjs          # section of the package.json version
//   node scripts/changelog.mjs 1.2.0    # section of 1.2.0
//
// Fails when the section is missing or empty, so a release cannot be published
// without documented changes.
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const version =
  process.argv[2] ?? JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8');

const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^## \\[?${escaped}\\]?(?:[ \\t].*)?$`);
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((line) => heading.test(line.trimEnd()));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for version ${version}`);
  process.exit(1);
}
const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
const notes = lines
  .slice(start + 1, end === -1 ? undefined : end)
  .join('\n')
  .trim();
if (!notes) {
  console.error(`CHANGELOG.md section for version ${version} is empty`);
  process.exit(1);
}
console.log(notes);
