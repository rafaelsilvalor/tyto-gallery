// Every test that reads a source does it against a real git repository made in a temporary
// folder and reached by a file:// URL, so tags, annotated and lightweight, are git's own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, test } from 'node:test';
import {
  applyBump,
  applyReadmeBump,
  newestReleaseAbove,
  openPullRequests,
  planBumps,
  readEntries,
  readTagInfo,
  tagsFromLsRemote,
  yamlScalar,
} from './release-watch.mjs';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...IDENTITY } });
}

const scratch = mkdtempSync(join(tmpdir(), 'release-watch-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let made = 0;

/** A template repository with the given tags; each tag commits a manifest with its engine. */
function templateRepository(tags) {
  made += 1;
  const folder = join(scratch, `template-${made}`);
  mkdirSync(folder);
  git(folder, 'init', '--quiet', '--initial-branch=main');
  for (const { name, engine, message } of tags) {
    if (engine === null) rmSync(join(folder, 'tyto-plugin.json'), { force: true });
    else writeFileSync(join(folder, 'tyto-plugin.json'), JSON.stringify({ name: 'x', engine: engine ?? '>=0.11' }));
    writeFileSync(join(folder, 'version.txt'), name);
    git(folder, 'add', '--all');
    git(folder, 'commit', '--quiet', '--message', `commit for ${name}`);
    if (message) git(folder, 'tag', '--annotate', name, '--message', message);
    else git(folder, 'tag', name);
  }
  return pathToFileURL(folder).href;
}

const sources = {
  listTags: (url) => tagsFromLsRemote(git(scratch, 'ls-remote', '--tags', '--', url)),
  tagInfo: (url, tag) => readTagInfo(url, tag, (args) => git(scratch, ...args)),
};

function indexFor(url, { latest = 'v1.0.0', id = 'tabela' } = {}) {
  return [
    '# The house index. A comment the bump must keep.',
    'version: 1',
    'entries:',
    `  - id: ${id}`,
    '    kind: template',
    '    name: Table',
    `    source: { git: ${url} }`,
    `    latest: ${latest} # pinned by the curator`,
    '    templates: [tabela]',
    '    # A comment inside the entry.',
    "    engine: '>=0.11'",
    '    changes: First release.',
    '',
    '  - id: other',
    '    kind: template',
    '    source: { git: file:///no/such/other.git }',
    '    latest: v0.1.0',
    '    changes: Untouched.',
    '',
  ].join('\n');
}

describe('release tags', () => {
  test('only v<major>.<minor>.<patch> counts, compared as numbers', () => {
    const tags = ['v1.0.0', 'v1.2.0', 'v1.10.0', 'v2.0.0-rc.1', '2.0.0', 'v1.9.9', 'latest', 'v01.20.0'];
    assert.equal(newestReleaseAbove(tags, 'v1.0.0'), 'v1.10.0');
    assert.equal(newestReleaseAbove(tags, 'v1.10.0'), undefined);
    assert.equal(newestReleaseAbove(['v0.9.0', 'v0.10.0'], 'v0.9.0'), 'v0.10.0');
  });

  test('ls-remote output drops peeled lines', () => {
    const output = 'aaa\trefs/tags/v1.0.0\nbbb\trefs/tags/v1.0.0^{}\nccc\trefs/tags/v1.1.0\n';
    assert.deepEqual(tagsFromLsRemote(output), ['v1.0.0', 'v1.1.0']);
  });
});

describe('planBumps against local repositories', () => {
  test('a newer annotated tag is found with its engine and subject', () => {
    const url = templateRepository([
      { name: 'v1.0.0', message: 'First release.' },
      { name: 'v1.1.0', engine: '>=0.14', message: 'Wider first column.\n\nThe body is not read.' },
    ]);
    const plan = planBumps(indexFor(url), sources);
    assert.equal(plan.bumps.length, 1);
    assert.deepEqual(
      { id: plan.bumps[0].id, from: plan.bumps[0].from, to: plan.bumps[0].to, engine: plan.bumps[0].engine, changes: plan.bumps[0].changes },
      { id: 'tabela', from: 'v1.0.0', to: 'v1.1.0', engine: '>=0.14', changes: 'Wider first column.' },
    );
  });

  test('a lightweight tag gets the placeholder changes line', () => {
    const url = templateRepository([{ name: 'v1.0.0', message: 'First.' }, { name: 'v1.0.1' }]);
    const [bump] = planBumps(indexFor(url), sources).bumps;
    assert.equal(bump.to, 'v1.0.1');
    assert.equal(bump.changes, 'Release v1.0.1.');
    assert.equal(bump.annotated, false);
  });

  test('a tag without tyto-plugin.json keeps the entry engine', () => {
    const url = templateRepository([{ name: 'v1.0.0' }, { name: 'v1.0.1', engine: null }]);
    const [bump] = planBumps(indexFor(url), sources).bumps;
    assert.equal(bump.engine, '>=0.11');
    assert.equal(bump.engineFound, false);
  });

  test('nothing moves when latest is the newest release tag', () => {
    const url = templateRepository([{ name: 'v0.9.0' }, { name: 'v1.0.0' }]);
    const plan = planBumps(indexFor(url), sources);
    assert.deepEqual(plan.bumps, []);
    assert.ok(plan.upToDate.includes('tabela'));
  });

  test('a pre-release or non-semver tag opens nothing', () => {
    const url = templateRepository([{ name: 'v1.0.0' }, { name: 'v1.1.0-rc.1' }, { name: 'nightly' }, { name: '1.2.0' }]);
    const plan = planBumps(indexFor(url), sources);
    assert.deepEqual(plan.bumps, []);
  });

  test('an unreachable source is a note, never up to date', () => {
    const plan = planBumps(indexFor('file:///no/such/repository.git'), sources);
    assert.deepEqual(plan.bumps, []);
    assert.ok(!plan.upToDate.includes('tabela'));
    assert.ok(plan.notes.some((note) => note.startsWith('tabela: git ls-remote')));
  });
});

describe('editing index.yaml', () => {
  test('only latest, engine and changes lines change; comments and order stay', () => {
    const before = indexFor('https://git.invalid/tabela.git');
    const after = applyBump(before, 'tabela', { latest: 'v1.1.0', engine: '>=0.14', changes: 'Wider first column.' });
    const old = before.split('\n');
    const now = after.split('\n');
    assert.equal(now.length, old.length);
    const changed = now.map((line, index) => (line === old[index] ? undefined : index)).filter((index) => index !== undefined);
    assert.deepEqual(changed, [7, 10, 11]);
    assert.equal(now[7], '    latest: v1.1.0 # pinned by the curator');
    assert.equal(now[10], "    engine: '>=0.14'");
    assert.equal(now[11], '    changes: Wider first column.');
    assert.equal(readEntries(after).find((entry) => entry.id === 'other').latest, 'v0.1.0');
  });

  test('changes that would not read back plain are quoted', () => {
    assert.equal(yamlScalar('Wider column.'), 'Wider column.');
    assert.equal(yamlScalar('Fix: the title'), "'Fix: the title'");
    assert.equal(yamlScalar("it's fine"), "it's fine");
    assert.equal(yamlScalar('Note #2 fixed'), "'Note #2 fixed'");
    assert.equal(yamlScalar('- dash'), "'- dash'");
    const after = applyBump(indexFor('https://git.invalid/t.git'), 'tabela', { latest: 'v1.1.0', changes: "Fix: Rafael's title" });
    assert.ok(after.includes("    changes: 'Fix: Rafael''s title'\n"));
  });

  test('a missing engine and changes are added after latest', () => {
    const text = 'version: 1\nentries:\n  - id: a\n    source: { git: x }\n    latest: v1.0.0\n    templates: [a]\n';
    const after = applyBump(text, 'a', { latest: 'v1.1.0', engine: '>=0.2', changes: 'New.' });
    assert.equal(after, "version: 1\nentries:\n  - id: a\n    source: { git: x }\n    latest: v1.1.0\n    engine: '>=0.2'\n    changes: New.\n    templates: [a]\n");
  });

  test('a changes line folded over two lines is replaced whole', () => {
    const text = 'entries:\n  - id: a\n    latest: v1.0.0\n    changes: One line\n      and its continuation.\n    preview: p.png\n';
    const after = applyBump(text, 'a', { latest: 'v1.0.1', changes: 'New.' });
    assert.equal(after, 'entries:\n  - id: a\n    latest: v1.0.1\n    changes: New.\n    preview: p.png\n');
  });

  test('the README table cell moves and keeps its width', () => {
    const readme = '| id     | latest | x |\n| ------ | ------ | - |\n| tabela | v1.0.0 | a |\n';
    assert.equal(applyReadmeBump(readme, 'tabela', 'v1.0.0', 'v1.1.0'), '| id     | latest | x |\n| ------ | ------ | - |\n| tabela | v1.1.0 | a |\n');
  });
});

describe('opening pull requests', () => {
  function workingCopy(index) {
    made += 1;
    const origin = join(scratch, `gallery-${made}.git`);
    const work = join(scratch, `gallery-${made}`);
    git(scratch, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    git(scratch, 'clone', '--quiet', pathToFileURL(origin).href, work);
    writeFileSync(join(work, 'index.yaml'), index);
    writeFileSync(join(work, 'README.md'), '| id     | latest |\n| tabela | v1.0.0 |\n');
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '--message', 'init');
    git(work, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
    return { origin, work };
  }

  function fakeGh(openRequests) {
    const calls = [];
    return {
      calls,
      gh: (args) => {
        calls.push(args.slice(0, 2).join(' '));
        if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(openRequests);
        return '';
      },
    };
  }

  test('a bump pushes its branch, opens one pull request and dispatches CI; a second run adds nothing', () => {
    const url = templateRepository([{ name: 'v1.0.0' }, { name: 'v1.1.0', message: 'Wider first column.' }]);
    const { origin, work } = workingCopy(indexFor(url));
    const plan = planBumps(readFileSync(join(work, 'index.yaml'), 'utf8'), sources);
    const first = fakeGh([]);
    openPullRequests(plan, { cwd: work, git: (args) => git(work, ...args), gh: first.gh, log: () => {} });
    assert.deepEqual(first.calls, ['pr list', 'pr create', 'workflow run']);
    const pushed = git(scratch, '--git-dir', origin, 'show', 'gallery/bump-tabela:index.yaml');
    assert.ok(pushed.includes('    latest: v1.1.0 # pinned by the curator'), pushed);
    assert.ok(git(scratch, '--git-dir', origin, 'show', 'gallery/bump-tabela:README.md').includes('| tabela | v1.1.0 |'));
    // The working copy is back on the base commit, unchanged.
    assert.ok(readFileSync(join(work, 'index.yaml'), 'utf8').includes('latest: v1.0.0'));
    const branchHead = git(scratch, '--git-dir', origin, 'rev-parse', 'gallery/bump-tabela');

    // GitHub now lists the pull request the first run opened.
    const second = fakeGh([{ number: 7, title: 'Bump tabela to v1.1.0', headRefName: 'gallery/bump-tabela' }]);
    openPullRequests(planBumps(readFileSync(join(work, 'index.yaml'), 'utf8'), sources), {
      cwd: work,
      git: (args) => git(work, ...args),
      gh: second.gh,
      log: () => {},
    });
    assert.deepEqual(second.calls, ['pr list']);
    assert.equal(git(scratch, '--git-dir', origin, 'rev-parse', 'gallery/bump-tabela'), branchHead);
  });

  test('a newer tag updates the open pull request instead of opening another', () => {
    const url = templateRepository([{ name: 'v1.0.0' }, { name: 'v1.1.0' }, { name: 'v1.2.0' }]);
    const { work } = workingCopy(indexFor(url));
    const fake = fakeGh([{ number: 7, title: 'Bump tabela to v1.1.0', headRefName: 'gallery/bump-tabela' }]);
    openPullRequests(planBumps(readFileSync(join(work, 'index.yaml'), 'utf8'), sources), {
      cwd: work,
      git: (args) => git(work, ...args),
      gh: fake.gh,
      log: () => {},
    });
    assert.deepEqual(fake.calls, ['pr list', 'pr edit', 'workflow run']);
  });

  test('an open bump pull request is closed once main lists the newest tag', () => {
    const url = templateRepository([{ name: 'v1.0.0' }]);
    const { work } = workingCopy(indexFor(url));
    const fake = fakeGh([{ number: 9, title: 'Bump tabela to v1.0.0', headRefName: 'gallery/bump-tabela' }]);
    openPullRequests(planBumps(readFileSync(join(work, 'index.yaml'), 'utf8'), sources), {
      cwd: work,
      git: (args) => git(work, ...args),
      gh: fake.gh,
      log: () => {},
    });
    assert.deepEqual(fake.calls, ['pr list', 'pr close']);
  });
});
