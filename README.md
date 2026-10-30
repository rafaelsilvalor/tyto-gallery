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

## Entries

| id                  | latest | configurations    |
| ------------------- | ------ | ----------------- |
| tabela              | v1.1.1 | roxo              |
| agenda-semana       | v1.1.0 |                   |
| aprovados           | v1.1.0 |                   |
| simulados-semana    | v1.0.1 | roxo, ocre, vinho |
| concursos-abertos   | v0.2.4 |                   |
| questao-estrategica | v0.3.0 |                   |
| banner              | v1.0.0 | roxo              |

**`banner` and the built-in `banner-roxo`.** Until the Tyto desktop release after
desktop-v0.12.0, Tyto still ships a built-in `banner-roxo`. Installing `banner` writes the bare
name, which does not collide; a plugin file that also gives it the alias `banner-roxo` (as
the template's README suggests) does, and two of one name load from neither (Tyto ADR 0151
decision 7).

No plugin is listed yet.

Adding or bumping an entry: [CONTRIBUTING.md](CONTRIBUTING.md).
