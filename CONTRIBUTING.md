# Adding or bumping an entry

Every change goes in by pull request; CI must be green before it merges.

## A new release tag opens its own pull request

`.github/workflows/release-watch.yml` runs every day at 08:00 UTC, and on demand from the
Actions tab (`workflow_dispatch`). For each entry it lists the source's tags with plain
`git ls-remote --tags` (no hosting service's API: Tyto ADR 0127) and takes the highest
**release tag** above `latest`. A release tag is exactly `v<major>.<minor>.<patch>`; a
pre-release (`v1.2.0-rc.1`), a tag without the `v` or any other name opens nothing.

For each entry with a newer release tag it pushes the branch `gallery/bump-<id>`, rebuilt from
`main`, and opens a pull request `Bump <id> to <tag>` that moves, on their own lines:

- `latest` to the tag, and the entry's row in the README table;
- `engine` to `tyto-plugin.json`'s `engine` at that tag (kept when the tag has none);
- `changes` to the annotated tag's subject line, or `Release <tag>.` for a lightweight tag.

Nothing else in `index.yaml` is rewritten: comments, order and blank lines stay. **The curator
still merges**, one version at a time (Tyto ADR 0162): rewrite `changes` in your own words when
the tag's subject is not one, and render a new preview if the art changed (below), by pushing
onto the branch before merging.

- **One pull request per entry, never two.** A run that finds the same tag leaves the open pull
  request alone; a newer tag rebuilds the branch and force-pushes it, replacing any commit
  pushed onto it, and retitles the pull request. Once `main` lists the newest tag (merged, or
  moved by hand) an open bump pull request for that entry is closed.
- **Its CI.** A pull request opened with the workflow's `GITHUB_TOKEN` starts `ci`, but GitHub
  holds that run for a person's approval (Tyto ADR 0154). The workflow therefore also starts
  `ci` with `workflow_dispatch` on the branch, which needs no approval and reports on the pull
  request's head commit. The held run can be approved or ignored.
- **The repository setting it needs.** Settings › Actions › General › "Allow GitHub Actions to
  create and approve pull requests" must be on; without it the run is red at `gh pr create`.
  The maintainer turns it on; the workflow does not.
- **Try it without pushing anything:** `node scripts/release-watch.mjs --dry-run` prints what
  would move. `npm test` runs its tests against git repositories made in a temporary folder.

## Bump an entry to a new tag by hand

1. The template's repository has released the tag (`git ls-remote --tags <its git>` shows it).
2. In `index.yaml`, set the entry's `latest` to the tag and rewrite `changes`: one line, in the
   curator's words, on what that tag changes for a person who updates. Tyto shows it beside
   "update available" and reads no release notes of its own.
3. If the tag moved the manifest's `engine`, copy it into the entry's `engine`.
4. If the art changed, render a new preview (below).

## Add an entry

1. Pick an `id`: lowercase letters, digits, `-` and `_`. It is what `tyto gallery install`
   takes, and a plugin's file name.
2. Copy an existing entry and fill every key. For a template: `templates` lists the names the
   repository's manifest declares; `configurations` the ones its README offers. For a plugin:
   `kind: plugin`, no `templates`. `engine` is `tyto-plugin.json`'s.
3. Render a preview (below).

## Render a preview without the brand kit

A preview is the first frame of the template's own example brief at `latest`, rendered with a
Tyto folder that holds no brand kit:

```sh
mkdir -p /tmp/g/home/plugin-files /tmp/g/work
# A plugin file naming only this entry, at its latest tag:
cat > /tmp/g/home/plugin-files/one.yaml <<'YAML'
version: 1
templates:
  <name>:
    source: { git: <its git>, ref: <latest> }
YAML
git clone --branch <latest> <its git> /tmp/g/repo
cp -r /tmp/g/repo/templates/<name>/examples/. /tmp/g/work/
cd /tmp/g/work
TYTO_HOME=/tmp/g/home tyto plugin sync --yes
TYTO_HOME=/tmp/g/home tyto render <example>.brief -o /tmp/g/out
cp /tmp/g/out/<first frame>.png <this repository>/previews/<id>.png
```

Render outside the template's repository: inside it, its `templates/` folder shadows the plugin.
**Open the picture before committing it**: the logo must be the placeholder (a rounded bar with
a dot) and the signature `@assinatura`. CI cannot see that.

## Check locally

```sh
npm install --no-package-lock   # needs a GitHub token for @rafaelsilvalor in ~/.npmrc
npm run check
```
