// Finds, for every entry of index.yaml, a release tag newer than its `latest`, and opens (or
// updates) one pull request per entry that moves `latest`, `engine` and `changes` to it. The
// curator still merges each one: an approval per version, as Tyto ADR 0162 decided.
//
// The gallery pulls rather than each template repository pushing: a workflow's GITHUB_TOKEN
// cannot write to another repository, so a push from every template repository would need a
// personal token stored in each. Tags are read with plain `git ls-remote --tags`, which works
// against any git host the runner can reach; no hosting service's API is called (Tyto ADR 0127).
//
// The index is edited line by line, never re-serialised, so its comments, key order and blank
// lines survive. `npm run check` (Tyto's own parser) reads the result in the pull request's CI.
//
// Usage, from the repository's root:
//   node scripts/release-watch.mjs --dry-run   # print what would move, touch nothing
//   node scripts/release-watch.mjs             # push gallery/bump-<id> branches, open PRs (needs gh)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BRANCH_PREFIX = 'gallery/bump-';

// Only `v<major>.<minor>.<patch>` is a release. A pre-release (`v1.2.0-rc.1`), a tag without
// the `v`, or any other name opens nothing.
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** The tag names in `git ls-remote --tags` output, without the peeled `^{}` lines. */
export function tagsFromLsRemote(output) {
  const tags = [];
  for (const line of output.split('\n')) {
    const ref = line.split('\t')[1]?.trim();
    if (!ref || !ref.startsWith('refs/tags/') || ref.endsWith('^{}')) continue;
    tags.push(ref.slice('refs/tags/'.length));
  }
  return tags;
}

/** The highest release tag strictly above `latest`, or undefined. */
export function newestReleaseAbove(tags, latest) {
  const floor = parseReleaseTag(latest);
  if (!floor) return undefined;
  let best;
  for (const tag of tags) {
    const version = parseReleaseTag(tag);
    if (!version || compareVersions(version, floor) <= 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best?.tag;
}

function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { eol, lines: text.split(eol) };
}

function indentOf(line) {
  return /^ */.exec(line)[0].length;
}

function isBlankOrComment(line) {
  return /^\s*(#.*)?$/.test(line);
}

/** A one-line scalar's value: quotes removed, a trailing comment dropped. */
function scalarValue(raw) {
  const text = raw.trim();
  if (text.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'/.exec(text);
    return match ? match[1].replaceAll("''", "'") : text;
  }
  if (text.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"/.exec(text);
    return match ? JSON.parse(`"${match[1]}"`) : text;
  }
  return text.replace(/\s+#.*$/, '');
}

/**
 * The entries of an index, read from its lines: what this script needs, and where each key
 * sits. Tyto's parser stays the judge of whether the file is valid; this reads the shape the
 * index is written in (`- id:` first, one key per line, `source` as `{ git: … }` or a nested
 * `git:`).
 */
export function readEntries(text) {
  const { lines } = splitLines(text);
  const entries = [];
  let current;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const start = /^( *)- id:(.*)$/.exec(line);
    if (start) {
      current = { id: scalarValue(start[2]), start: index, end: index + 1, keyIndent: start[1].length + 2, keys: {} };
      current.keys.id = { line: index, end: index + 1 };
      entries.push(current);
      continue;
    }
    if (!current || isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    if (indent < current.keyIndent) {
      current = undefined;
      continue;
    }
    if (indent === current.keyIndent) {
      const key = /^ *([A-Za-z_][\w-]*):(.*)$/.exec(line);
      if (key) current.keys[key[1]] = { line: index, end: index + 1, raw: key[2] };
    } else {
      // A continuation of the last key: a folded scalar's next line, or a nested mapping.
      const last = Object.values(current.keys).sort((a, b) => b.line - a.line)[0];
      last.end = index + 1;
    }
    current.end = index + 1;
  }
  return entries.map((entry) => {
    const source = entry.keys.source;
    let git;
    if (source) {
      const block = lines.slice(source.line, source.end).join('\n');
      git = /\bgit:\s*['"]?([^\s,'"}]+)/.exec(block)?.[1];
    }
    const latest = entry.keys.latest ? scalarValue(entry.keys.latest.raw) : undefined;
    const engine = entry.keys.engine ? scalarValue(entry.keys.engine.raw) : undefined;
    return { ...entry, git, latest, engine };
  });
}

/** A YAML scalar for one line of text: plain when that reads back as the same string. */
export function yamlScalar(value) {
  const plain =
    value !== '' &&
    !/^[-?:,[\]{}#&*!|>'"%@`\s]/.test(value) &&
    !/: |\s#|:$|\s$/.test(value) &&
    !/^(true|false|null|yes|no|on|off|~)$/i.test(value) &&
    !/^[-+.\d]/.test(value);
  return plain ? value : `'${value.replaceAll("'", "''")}'`;
}

function trailingComment(raw, value) {
  // Only a one-line, single-word value (latest, a quoted engine) keeps a comment beside it;
  // `changes` is free text, rewritten whole.
  const match = /^\s*('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|\S+)(\s+#.*)$/.exec(raw ?? '');
  return match && value !== undefined ? match[2] : '';
}

/**
 * index.yaml with one entry moved: `latest`, `engine` and `changes` rewritten on their own
 * lines, every other line as it was. An absent `engine` or `changes` is added after `latest`.
 */
export function applyBump(text, id, { latest, engine, changes }) {
  const { eol, lines } = splitLines(text);
  const entry = readEntries(text).find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`index.yaml has no entry ${id}`);
  if (!entry.keys.latest) throw new Error(`entry ${id} has no latest`);
  const pad = ' '.repeat(entry.keyIndent);
  const wanted = [
    ['latest', latest, latest],
    ['engine', engine, engine === undefined ? undefined : `'${engine.replaceAll("'", "''")}'`],
    ['changes', changes, changes === undefined ? undefined : yamlScalar(changes)],
  ];
  // Edit from the bottom up so earlier line numbers stay true.
  const edits = [];
  for (const [key, value, written] of wanted) {
    if (value === undefined) continue;
    const place = entry.keys[key];
    if (place) {
      const comment = key === 'changes' ? '' : trailingComment(place.raw, value);
      edits.push({ at: place.line, remove: place.end - place.line, insert: [`${pad}${key}: ${written}${comment}`] });
    } else {
      edits.push({ at: entry.keys.latest.end, remove: 0, insert: [`${pad}${key}: ${written}`], order: key });
    }
  }
  edits.sort((a, b) => b.at - a.at || (a.order === 'engine' ? 1 : -1));
  for (const edit of edits) lines.splice(edit.at, edit.remove, ...edit.insert);
  return lines.join(eol);
}

/** README.md's entries table with the entry's `latest` cell moved, the column kept aligned. */
export function applyReadmeBump(text, id, from, to) {
  const { eol, lines } = splitLines(text);
  const index = lines.findIndex((line) => line.startsWith('|') && line.split('|')[1]?.trim() === id);
  if (index === -1) return text;
  const cells = lines[index].split('|');
  if (cells[2]?.trim() !== from) return text;
  const width = cells[2].length;
  cells[2] = ` ${to.padEnd(Math.max(width - 2, to.length))} `;
  lines[index] = cells.join('|');
  return lines.join(eol);
}

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...options,
  });
}

function gitRunner(args, cwd) {
  return runCommand('git', args, cwd ? { cwd } : {});
}

/** What a release tag says about itself: annotated or not, its subject, the manifest's engine. */
export function readTagInfo(git, tag, run = gitRunner) {
  const scratch = mkdtempSync(join(tmpdir(), 'release-watch-'));
  try {
    run(['init', '--quiet', '--bare', scratch]);
    run(['-C', scratch, 'fetch', '--quiet', '--depth=1', '--no-tags', '--', git, `+refs/tags/${tag}:refs/tags/${tag}`]);
    const [type, ...subject] = run(['-C', scratch, 'for-each-ref', '--format=%(objecttype) %(contents:subject)', `refs/tags/${tag}`])
      .trim()
      .split(' ');
    let engine;
    try {
      const manifest = JSON.parse(run(['-C', scratch, 'show', `refs/tags/${tag}^{commit}:tyto-plugin.json`]));
      if (typeof manifest.engine === 'string') engine = manifest.engine;
    } catch {
      engine = undefined;
    }
    return { annotated: type === 'tag', subject: subject.join(' ').trim(), engine };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function changesFor(tag, info) {
  return info.annotated && info.subject !== '' ? info.subject : `Release ${tag}.`;
}

/**
 * Which entries move, read against the sources. `upToDate` names the entries whose newest
 * release tag is already `latest`; an entry that could not be read is in neither list, only
 * in `notes`, so a transient failure never closes its pull request.
 */
export function planBumps(text, { listTags, tagInfo }) {
  const bumps = [];
  const upToDate = [];
  const notes = [];
  for (const entry of readEntries(text)) {
    if (!entry.git || !entry.latest) {
      notes.push(`${entry.id}: no source git or latest; skipped`);
      continue;
    }
    if (!parseReleaseTag(entry.latest)) {
      notes.push(`${entry.id}: latest ${entry.latest} is not a release tag (v<major>.<minor>.<patch>); skipped`);
      continue;
    }
    let tags;
    try {
      tags = listTags(entry.git);
    } catch (cause) {
      notes.push(`${entry.id}: git ls-remote ${entry.git} failed: ${String(cause.message).split('\n')[0]}`);
      continue;
    }
    if (!tags.includes(entry.latest)) notes.push(`${entry.id}: latest ${entry.latest} is not a tag of ${entry.git}`);
    const newest = newestReleaseAbove(tags, entry.latest);
    if (!newest) {
      upToDate.push(entry.id);
      continue;
    }
    let info;
    try {
      info = tagInfo(entry.git, newest);
    } catch (cause) {
      notes.push(`${entry.id}: reading ${newest} failed: ${String(cause.message).split('\n')[0]}`);
      continue;
    }
    bumps.push({
      id: entry.id,
      git: entry.git,
      from: entry.latest,
      to: newest,
      // No manifest, or no engine in it, leaves the entry's engine as it is.
      engine: info.engine ?? entry.engine,
      engineFound: info.engine !== undefined,
      changes: changesFor(newest, info),
      annotated: info.annotated,
    });
  }
  return { bumps, upToDate, notes };
}

export function titleFor(bump) {
  return `Bump ${bump.id} to ${bump.to}`;
}

export function bodyFor(bump) {
  return [
    `Moves \`${bump.id}\` from \`${bump.from}\` to \`${bump.to}\`, the newest release tag of ${bump.git}.`,
    '',
    `- \`engine\`: \`${bump.engine ?? '(none)'}\`${bump.engineFound ? ", read from the tag's tyto-plugin.json" : ', unchanged: the tag has no tyto-plugin.json engine'}.`,
    `- \`changes\`: ${bump.annotated ? "the annotated tag's subject" : `a lightweight tag, so the placeholder "Release ${bump.to}."`}.`,
    '',
    'Opened by the `release-watch` workflow. Before merging, the curator:',
    '',
    "1. rewrites `changes` in the curator's words when the tag's subject is not already one (CONTRIBUTING.md);",
    '2. renders a new preview if the art changed;',
    '3. merges. Nothing reaches a person until this does, and then only when they run `tyto gallery update`.',
    '',
    `The branch is the workflow's: a newer tag rebuilds it from \`main\` and force-pushes, replacing any commit pushed onto it.`,
  ].join('\n');
}

/**
 * Pushes one branch per bump and opens or updates its pull request; closes a bot pull request
 * whose entry `main` already lists at its newest tag. `git` and `gh` run commands in `cwd`.
 */
export function openPullRequests(plan, { cwd, git, gh, indexPath = 'index.yaml', readmePath = 'README.md', base = 'main', ciWorkflow = 'ci.yml', log = console.log }) {
  const open = JSON.parse(gh(['pr', 'list', '--state', 'open', '--limit', '200', '--json', 'number,title,headRefName']));
  const baseSha = git(['rev-parse', 'HEAD']).trim();
  const indexText = readFileSync(join(cwd, indexPath), 'utf8');
  let readmeText;
  try {
    readmeText = readFileSync(join(cwd, readmePath), 'utf8');
  } catch {
    readmeText = undefined;
  }
  try {
    for (const bump of plan.bumps) {
      const branch = `${BRANCH_PREFIX}${bump.id}`;
      const title = titleFor(bump);
      const existing = open.find((request) => request.headRefName === branch);
      if (existing && existing.title === title) {
        log(`kept #${existing.number}: ${title} is already open`);
        continue;
      }
      git(['checkout', '--quiet', '-B', branch, baseSha]);
      writeFileSync(join(cwd, indexPath), applyBump(indexText, bump.id, { latest: bump.to, engine: bump.engine, changes: bump.changes }));
      if (readmeText !== undefined) writeFileSync(join(cwd, readmePath), applyReadmeBump(readmeText, bump.id, bump.from, bump.to));
      git(['commit', '--quiet', '--all', '--message', `feat: bump ${bump.id} to ${bump.to}`]);
      git(['push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${branch}`]);
      const body = bodyFor(bump);
      if (existing) {
        gh(['pr', 'edit', String(existing.number), '--title', title, '--body', body]);
        log(`updated #${existing.number}: ${title}`);
      } else {
        gh(['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body]);
        log(`opened: ${title}`);
      }
      // A push made with GITHUB_TOKEN starts CI only after a person approves the run;
      // `workflow_dispatch` is the event that token may start without one (Tyto ADR 0154).
      gh(['workflow', 'run', ciWorkflow, '--ref', branch]);
    }
  } finally {
    git(['checkout', '--quiet', '--detach', baseSha]);
  }
  for (const id of plan.upToDate) {
    const stale = open.find((request) => request.headRefName === `${BRANCH_PREFIX}${id}`);
    if (!stale) continue;
    gh(['pr', 'close', String(stale.number), '--delete-branch', '--comment', `\`main\` already lists ${id} at its newest release tag.`]);
    log(`closed #${stale.number}: ${id} is up to date on main`);
  }
}

function describe(plan) {
  const lines = [];
  for (const bump of plan.bumps) {
    lines.push(`bump ${bump.id} ${bump.from} -> ${bump.to} (engine ${bump.engine ?? '(none)'}${bump.engineFound ? '' : ' kept'}; changes: ${bump.changes})`);
  }
  for (const id of plan.upToDate) lines.push(`ok ${id}: latest is the newest release tag`);
  for (const note of plan.notes) lines.push(`note ${note}`);
  return lines;
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const cwd = process.cwd();
  const indexText = readFileSync(join(cwd, 'index.yaml'), 'utf8');
  const plan = planBumps(indexText, {
    listTags: (git) => tagsFromLsRemote(gitRunner(['ls-remote', '--tags', '--', git])),
    tagInfo: (git, tag) => readTagInfo(git, tag),
  });
  for (const line of describe(plan)) console.log(line);
  if (dryRun) {
    console.log(`dry run: ${plan.bumps.length} of ${plan.bumps.length + plan.upToDate.length} entries would move; nothing pushed`);
    return;
  }
  openPullRequests(plan, {
    cwd,
    git: (args) => gitRunner(args, cwd),
    gh: (args) => runCommand('gh', args, { cwd }),
    base: process.env.BASE_BRANCH || 'main',
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
