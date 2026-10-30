# Adding or bumping an entry

Every change goes in by pull request; CI must be green before it merges.

## Bump an entry to a new tag

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
