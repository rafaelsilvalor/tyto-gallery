// Checks index.yaml the way Tyto reads it, then checks what Tyto cannot check from the index
// alone: that every entry's tag exists in its repository and that its preview is in this one.
// Any diagnostic fails the run, a warning too: a key Tyto ignores is a key the curator meant.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseGalleryIndex } from '@tyto/plugin-api';

const INDEX = 'index.yaml';
const source = readFileSync(INDEX, 'utf8');
const failures = [];

function lineOf(offset) {
  return source.slice(0, offset).split('\n').length;
}

const read = parseGalleryIndex(source, INDEX);
for (const diagnostic of read.diagnostics) {
  const where = diagnostic.range ? `${INDEX}:${lineOf(diagnostic.range.start)}` : INDEX;
  failures.push(`${where} ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
}

const entries = read.value?.entries ?? [];
if (entries.length === 0) failures.push(`${INDEX} lists no entry`);

for (const entry of entries) {
  const where = entry.range ? `${INDEX}:${lineOf(entry.range.start)}` : INDEX;
  const failuresBefore = failures.length;
  // The person's `git` reaches the tag the same way, so `ls-remote` is the check that matters.
  // GIT_TERMINAL_PROMPT=0 as Tyto sets it: a repository that asks for credentials fails here.
  let tags = '';
  try {
    tags = execFileSync('git', ['ls-remote', '--tags', '--', entry.git, `refs/tags/${entry.latest}`], {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (cause) {
    failures.push(`${where} ${entry.id}: git ls-remote ${entry.git} failed: ${cause.message.split('\n')[0]}`);
    continue;
  }
  if (tags.trim() === '') failures.push(`${where} ${entry.id}: tag ${entry.latest} not found in ${entry.git}`);
  if (entry.preview === undefined) failures.push(`${where} ${entry.id}: no preview`);
  else if (!existsSync(entry.preview)) failures.push(`${where} ${entry.id}: preview ${entry.preview} is not in this repository`);
  if (entry.changes === undefined) failures.push(`${where} ${entry.id}: no changes line for ${entry.latest}`);
  if (failures.length === failuresBefore) console.log(`ok ${entry.id} ${entry.latest}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(`${entries.length} entries checked`);
