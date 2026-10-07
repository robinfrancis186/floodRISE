# Contributing to floodRISE

Start with the [README](README.md) for setup and the
[implementation status](docs/IMPLEMENTATION_STATUS.md) for current boundaries.

## Report an issue

Use [GitHub issues](https://github.com/robinfrancis186/floodRISE/issues) for bugs
and feature requests. Include the affected app/route, steps to reproduce,
expected and actual behavior, browser/device, and a screenshot where useful.
Use synthetic reports and remove identities, precise personal locations,
credentials, and private evidence from attachments.

Do not put vulnerability details or secrets in public issues. Use GitHub's
private vulnerability reporting if it is enabled for this repository, or
arrange a private channel with the repository owner.

## Make a change

1. Create a branch and keep the change focused.
2. Reuse shared map/UI/contracts rather than duplicating app behavior.
3. Preserve demo labels, unofficial evidence wording, approval checks,
   private-media controls, and offline freshness restrictions.
4. Document changed setup, configuration, and feature boundaries.
5. Open a pull request describing what changed, why, and which checks ran.

For code changes, install both Python service environments and run relevant
checks from [quality gates](docs/QUALITY_GATES.md). UI changes should include
keyboard and narrow-screen review; the browser suite also runs axe smoke scans.
Documentation-only changes do not need an application build: check paths,
commands, claims, and `git diff --check`.

## Data and generated files

- Preserve source IDs, attribution, snapshot timestamps, and checksum manifests
  when changing geographic fixtures; follow each fixture's README.
- Never describe an OSM school or hall as an activated shelter without verified
  operational data.
- Regenerate the API client with `pnpm api:generate` when OpenAPI changes.
- Keep generated screenshots tied to an actual reviewed app state.

Application source licensing has not yet been declared. Data and dependency
licences do not grant a licence for the repository's own source; see the
[README licensing section](README.md#data-attribution-and-licensing).
