# Contributing to Clawd on Desk

[中文版](CONTRIBUTING.zh-CN.md)

Thanks for helping out. Clawd on Desk is a community-driven project: most translations, several agent integrations, and the mobile companion all came from contributors. This page tells you where things go and what a mergeable pull request looks like.

If something here is unclear, open a [Discussion](https://github.com/rullerzhou-afk/clawd-on-desk/discussions). You can write in English or Chinese anywhere in this repository.

## Ways to contribute

| You want to… | Start here |
| --- | --- |
| Report a bug or an agent that is not detected | [New issue](https://github.com/rullerzhou-afk/clawd-on-desk/issues/new/choose) — pick the bug or integration template |
| Suggest a feature | Feature request template, or a Discussion if it is still an idea |
| Ask a usage question | [Discussions](https://github.com/rullerzhou-afk/clawd-on-desk/discussions), not Issues |
| Translate the UI or a README | See [Translations](#translations) |
| Add support for another AI coding tool | See [Agent integrations](#agent-integrations) |
| Make a theme | See [Themes](#themes) |
| Fix docs | Edit the file under `docs/guides/` or the README and open a PR |

Before starting anything larger than a small fix, open an issue or comment on an existing one so we can agree on the approach first. It saves everyone from reviewing work that cannot be merged.

## Run from source

Requirements: Node.js 22.12 or newer, plus git.

```bash
git clone https://github.com/rullerzhou-afk/clawd-on-desk.git
cd clawd-on-desk
npm install
npm start
```

`npm install` downloads Electron and build tooling, so the `node_modules` tree is large. Run from source only when you are contributing or debugging; everyone else should use the packaged releases.

Useful commands:

```bash
npm test                 # the full test suite (node --test); run it before every PR
npm run audit:assets     # checks repository assets after adding or changing artwork
npm run create-theme     # scaffolds a new theme folder
bash test-demo.sh        # plays the animation states for a quick visual check
```

`AGENTS.md` is the operational entry point for this codebase, written for coding agents but just as useful for people: it lists the commands, the architecture docs under `docs/project/`, and the rules for agent integrations.

## Translations

The UI ships in English, Simplified Chinese, Traditional Chinese, Korean, Japanese, Brazilian Portuguese, and Spanish. Five of those were contributed by the community, so this is the most common first PR.

UI strings live in two files, keyed by language:

- `src/i18n.js` — menu, pet, and notification strings
- `src/settings-i18n.js` — the Settings panel

To fix or improve an existing language, edit the entries for that language in both files. To add a new language:

1. Add the language to `SUPPORTED_LANGS` in `src/i18n.js` and add a full locale object to **both** files. Copy the `en` block and translate every value; keep the keys in the same order.
2. Keep placeholders such as `{n}` or `{w}×{h}` exactly as they are in English.
3. Run `npm test`. `test/i18n.test.js` fails if any key is missing, out of order, or has different placeholders from `en`. That is the whole review checklist for strings.
4. Give the language a display name: add a `lang…` entry next to `langKorean` and friends in `src/settings-i18n.js`, in every locale block. The picker itself reads `SUPPORTED_LANGS`, so `src/language-picker.js` needs no change, but two files keep their own copy of the language list and must be updated too: `src/permission-automation-confirmation.js` and `src/roam-fence-picker.js`.

README translations are welcome too: copy `README.md` to `README.<lang>.md` (see `README.ko-KR.md` for the naming) and link it from the language row at the top of each README. Guides under `docs/guides/` follow the same pattern (`setup-guide.zh-CN.md`).

Machine translation is fine as a starting point, but please read through the result as a user of that language would. Mention in the PR whether you are a native or fluent speaker.

## Agent integrations

Clawd learns what an AI coding tool is doing through hooks, log polling, plugins, or extensions. Each supported tool has an adapter in `agents/` and an installer in `hooks/` (for example `agents/codex.js` and `hooks/codex-install.js`).

Before adding a tool:

- Check `docs/guides/custom-agent-http.md`. If the tool can send HTTP state events, registering it as a custom HTTP agent may be enough and needs no code in this repository.
- Open an integration issue describing how the tool exposes its state (hooks, logs, a plugin API). Link to the tool's docs.
- Read `docs/project/agent-runtime-architecture.md` for the module boundaries, and `AGENTS.md` for the install, enable, and uninstall rules every integration must follow. In short: a new install must not touch configuration the user did not ask Clawd to manage, and uninstall must remove only what Clawd added.

A new integration PR normally includes the adapter, the installer and uninstaller, tests under `test/`, a setup guide under `docs/guides/`, and the tool added to the lists in `AGENTS.md`, the README "Supported Agents" line, and `docs/guides/supported-agents.md`.

## Themes

See the [theme creation guide](docs/guides/guide-theme-creation.md) for the format and local validation. To submit a theme for inclusion in **Settings → Theme**, read [Contributing external themes](docs/guides/contributing-themes.md) and open a [theme submission issue in this repository](https://github.com/rullerzhou-afk/clawd-on-desk/issues/new?template=theme-submission.yml). Ideas and artwork proposals are welcome; inclusion requires review.

Keep artwork in the author's repository or releases. Accepted packages are distributed through [`clawd-themes`](https://github.com/rullerzhou-afk/clawd-themes), without merging the assets into the application repository; community listing is still being prepared (see [Current status](docs/guides/contributing-themes.md#current-status)). The contribution guide covers deliverables, licenses, actual usability checks, updates, and independent sharing without catalog inclusion.

The built-in IDs (`clawd`, `calico`, `cloudling`), official downloadable IDs (`hash-sage`, `whale-chan`), `template`, and existing catalog IDs are unavailable for new submissions. External themes retain their own artwork licenses; provide credits, sources, and distribution permissions. Built-in artwork changes remain subject to separate review in this repository.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep one PR to one responsibility. A fix and an unrelated refactor should be two PRs.
3. Run `npm test` locally and make sure it passes.
4. Fill in the PR template. Its four sections are what reviewers read first:
   - **Summary** — the problem and the resulting behavior; link the issue (`Closes #123`).
   - **What changed** — grouped by responsibility, not file by file.
   - **Validation** — the checks you actually ran and their results. Say plainly what you did not test. For UI changes, add a screenshot or a short recording.
   - **Scope control** — what the PR deliberately does not do.
5. Remove tokens, credentials, private prompts, and personal data from logs, screenshots, and recordings before posting them.
6. Expect questions. Reviews here are thorough because Clawd writes into other tools' configuration; a follow-up commit on the same branch is the normal way to respond.

Using an AI coding agent to write the change is fine, and common here. What matters is that you ran the result, understood it, and described the validation honestly. A PR whose description was generated but never checked will be sent back.

Commit messages follow a light conventional style, for example `fix(codex): …`, `feat(theme): …`, `docs: …`, `test(i18n): …`. Squash or tidy as you like; the merge commit carries the PR title.

## Security

Please do not open a public issue for a security problem such as a way to run code through a hook or to read another tool's credentials. Use GitHub's private vulnerability reporting instead: [Report a vulnerability](https://github.com/rullerzhou-afk/clawd-on-desk/security/advisories/new). Only the maintainers can see it until a fix is out.

## License

By contributing application source code, you agree that it is licensed under the [GNU AGPL v3](LICENSE), the same license as the project. Artwork and external themes use their stated licenses; see the [README license notes](README.md#license). Third-party materials submitted to this repository must be listed in `NOTICE.md`.
