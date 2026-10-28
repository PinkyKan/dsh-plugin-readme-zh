# Chinese Plugin Docs

English | 中文（由本插件自动翻译）

Translate the documentation of any installed plugin on the Plugins page into Simplified Chinese — both the long detail document and the list-row title/description one-liners — keep every result in a persistent cache, and re-translate only the parts a plugin update actually changes.

## Summary

DSH plugins ship their user documentation as an English README (or a `meta.detail` document), and their list rows show the bundle's `meta.title` / `meta.description` with a literal English fallback. This bundle does two things:

1. Adds a **中文说明** control to the head of every installed plugin's detail page. The control opens a dialog with the translated long document, live progress, and cache statistics.
2. Makes the **Plugins list itself render Chinese**: it translates each bundle's short one-line meta and writes the result into the bundle's own locale files, so the host's normal locale resolution displays it natively — no client-side DOM patching.

All translations are produced by the model selected as the agent default (or an explicitly configured provider and model), and are stored under `$DSH_HOME/plugin-data/dsh-plugin-readme-zh/` (Markdown segments plus short strings).

## Use this plugin

1. Install the bundle. On every start it automatically translates the list one-liners of all installed plugins (in the background; already-cached strings cost nothing).
2. Open **Settings → Plugins**: installed rows now show Chinese one-line descriptions next to their package names.
3. Open any installed plugin's detail page; its header shows a **中文说明** button. Select it.
4. On first use the document is translated and the dialog shows a progress bar. Later visits read the cache and open instantly.
5. **重新翻译** forces a fresh translation. **翻译全部已安装插件** translates every installed plugin's long document in the background (and refreshes the list one-liners too); progress appears beside the button.
6. **复制中文** copies the translated Markdown.

The detail button is hidden when the plugin has no readable document, its files are unavailable, or its document is already Chinese.

## How the list rows become Chinese

Opt-in via `metaSidecars: true` (off by default). When enabled, for each profile-installed bundle the translations are kept in its own package directory:

- `locale/zh.json` gains `meta.title` / `meta.description` (merged into any existing file; author-provided Chinese is never touched);
- when the package ships no `locale/` directory at all, a `locale/en.json` mirroring the original English text is added too, because the loader reads no locale dictionaries without the English seed file;
- when the package declares an `exports` map, the standard DSH entry `"./locale/*.json": "./locale/*.json"` is appended so the module resolver can see the locale files (packages without an `exports` map need nothing).

These are small, additive, idempotent writes into the installed package's own directory; a `pnpm install` that re-extracts the package simply resets it, and the next start re-applies it from the string cache.

## Understand the cache

Every document is split into ordered Markdown segments:

- fenced code blocks, HTML comment blocks, and standalone HTML tag lines are kept verbatim and never sent to the model;
- the text is cut at every Markdown heading (`#` … `######`) first, so each section becomes its own chunk group: inserting or reordering a section changes only that section's hashes, not the rest of the document;
- within a section, prose is packed into chunks of at most 3000 characters at line boundaries;
- each chunk is keyed by the SHA-256 of its exact source text.

The cache file records the document hash, the chunk hashes, and their translations. When a plugin is updated:

- unchanged chunks keep their hash and are reused;
- only chunks whose source text changed are sent to the model;
- a version bump with an identical document costs no model calls at all.

A translation interrupted by a restart keeps its finished chunks, so the next run continues instead of starting over.

## Configuration

Set these fields on the bundle row in the profile patch when the defaults do not fit:

| Field | Default | Meaning |
|---|---|---|
| `engine` | `auto` | `auto` prefers the model service and falls back to the translator service; `llm` requires a model; `translator` uses only `ctx.translator`. |
| `provider` | agent default | Model provider route for translation. |
| `model` | agent default | Model id for translation. |
| `reasoningEffort` | `off` when supported | Reasoning effort for the translation call. |
| `maxTokens` | `8192` | Output-token cap per chunk. |
| `translatorProvider` | `bing` | Provider used when the translator fallback runs. |
| `metaSidecars` | `false` | Opt-in: also write the translated list-row one-liners into the installed packages' own `locale/` files (plus one standard `exports` entry where needed) so the Plugins list renders Chinese natively. **Off by default** — a public install keeps its hands off other packages. Set `true` to enable the list-row feature. |

The translation prompt requires the model to preserve Markdown syntax, code, URLs, file paths, package names, and identifiers, and to return only the translated fragment.

## Limitations

- The long detail document and the list-row one-line meta are translated; deep configuration field labels, row titles, and in-document strings stay in their original language.
- The first translation of a long document needs one model call per chunk; a 30 KB README usually takes a handful of calls.
- Transient model failures are retried on the model itself (three attempts with backoff). Only a structural failure (no provider, missing credentials, exceeded context window) uses the anonymous translator fallback, and that decision is made per chunk.
- A chunk that is almost entirely code or symbols and still comes back without Chinese text is kept verbatim and counted under `keptSource`; it stays that way on later runs of an unchanged document.
- A translated document is stored as a whole; editing the cached file by hand is not supported.
- The dialog renders Markdown with a deliberately small renderer. Raw HTML is reduced to its text content, external images are shown as their alt text, and links are limited to HTTP(S), `mailto:`, and in-page anchors.
- The list-row translation (writing `locale/*.json` sidecars and one `exports` entry) is **opt-in via `metaSidecars: true`, off by default**, so a public install does not touch other packages. When enabled, a `pnpm install` that re-extracts a package resets those files; the next start re-applies them from the cache.
- The translation cache belongs to this profile's `$DSH_HOME`; another profile starts with an empty cache.

## Distribution

The package is a plain DSH bundle with no npm dependencies of its own, so any of these work:

| Route | How | Notes |
|---|---|---|
| **Tarball (offline)** | `npm pack` → share the `.tgz` → install with `dsh plugin --profile <name> add file:/abs/path/<name>.tgz` | Needs no registry and no network. This is the route used on machines where GitHub and the npm website are unreachable. |
| **Local directory** | `dsh plugin --profile <name> add link:/abs/path/dsh-plugin-readme-zh` | Live edits are picked up on reload; used during development. |
| **npm registry** | `npm publish --registry=https://registry.npmjs.org/`, then `dsh plugin --profile <name> add <package-name>` | Requires an npm account created through the website; a mirror such as `registry.npmmirror.com` cannot publish. |
| **Git repository** | `dsh plugin --profile <name> add git+https://github.com/<owner>/<repo>` | The bundle reads its files from a checkout; needs reachable GitHub. |

After any of these, enable the bundle in the Plugins page (or add it to `dsh.profile.bundles`) and set `metaSidecars: true` if the list-row translation is wanted.

## Verification

The bundle was checked through static syntax checks and unit tests of the Markdown splitter (code fences, tables, HTML blocks, and long prose all round-trip exactly) plus live checks in the running Web profile: the routes answer on `/api/plugin-readme-zh` and its `/v1` alias, the **中文说明** control appears on installed plugin detail pages, and the list-row meta sidecars were confirmed by the loader reporting `skipped` (already-Chinese) for every profile bundle.

## Troubleshooting

- When the **中文说明** control is missing, the plugin has no readable document, its files are unavailable, or its document is already Chinese.
- When a list row still shows English after an update, the package was re-extracted by pnpm; the next DSH start (or **翻译全部已安装插件**) re-applies the cached translation and re-writes its locale sidecar.
- When translation fails, the dialog shows the model provider failure. Setting `engine: translator` switches to the anonymous translation service.
- The first run performs one model call per segment; later runs reuse every unchanged segment.
- The translated document is rendered with the same Markdown structure, and code blocks are never translated.
