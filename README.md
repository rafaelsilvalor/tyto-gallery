# tyto-gallery

The house's gallery index for [Tyto](https://github.com/rafaelsilvalor/tyto): the templates
and plugins a person can list, install and update from Tyto (Tyto ADR 0162).

```sh
tyto gallery list --index https://github.com/rafaelsilvalor/tyto-gallery.git
tyto gallery install tabela --index https://github.com/rafaelsilvalor/tyto-gallery.git
tyto gallery update tabela --index https://github.com/rafaelsilvalor/tyto-gallery.git
```

`TYTO_GALLERY_INDEX` set to the same URL stands in for `--index`. Tyto has no built-in default
index; which list a machine trusts is the person's choice.

## What is here

- **`index.yaml`**: one entry per template or plugin. Tyto reads it at this repository's
  default branch; each entry's `latest` is the tag `install` pins and `update` moves to.
  Nothing moves on a person's machine until they run `update`.
- **`previews/`**: one picture per entry, rendered from the template's own example brief at
  `latest` **without the brand kit**: the logo and the signature are the placeholders every
  public repository draws (Tyto E15). A preview with a real logo or handle is not merged.
- **CI** (`.github/workflows/ci.yml`): reads `index.yaml` with Tyto's own parser
  (`@tyto/plugin-api`) and fails on any diagnostic, warnings included; checks every entry's tag
  with `git ls-remote`; checks every preview is here. It also runs weekly, because a tag removed
  upstream breaks the index without a commit here.
- **Release watch** (`.github/workflows/release-watch.yml`): daily, opens one pull request per
  entry whose repository has a newer `v<major>.<minor>.<patch>` tag; the curator merges it.

## Entries

| id                  | latest | configurations    |
| ------------------- | ------ | ----------------- |
| tabela              | v1.2.0 | roxo              |
| agenda-semana       | v1.1.0 |                   |
| aprovados           | v1.1.0 |                   |
| simulados-semana    | v1.0.1 | roxo, ocre, vinho |
| concursos-abertos   | v0.3.0 |                   |
| questao-estrategica | v0.7.2 |                   |
| voce-conhece        | v0.6.0 |                   |
| news-da-semana      | v0.3.0 |                   |
| banner              | v1.1.0 | roxo              |

No plugin is listed yet.

Adding or bumping an entry: [CONTRIBUTING.md](CONTRIBUTING.md).
