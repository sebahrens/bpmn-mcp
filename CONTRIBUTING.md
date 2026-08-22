# Contributing to MCP-BPMN

Thank you for improving MCP-BPMN. This guide covers the complete contributor
workflow from a fresh clone through a pull request. It does not authorize a
deployment, an npm publish, or any other release operation.

## Prerequisites

- Git
- Node.js 22.12.0 or newer
- npm, as supplied with Node.js

CI tests the minimum supported Node.js release, 22.12, and the current Node.js
24 line. Keep `package-lock.json` synchronized with `package.json` and use
`npm ci` for a reproducible install. The renderer tests use Puppeteer, so the
install needs to be able to download its supported browser and the test machine
must be able to launch it.

## Set up a development checkout

```bash
git clone https://github.com/oisee/mcp-bpmn.git
cd mcp-bpmn
npm ci
npm run build
```

Create a focused branch before changing files:

```bash
git switch -c <type>/<short-description>
```

Use a short type such as `fix`, `feat`, or `docs`. Make the smallest complete
change, follow the existing TypeScript and test patterns, and add focused tests
for behavior changes.

## Checks and tests

The following commands are the supported contributor entry points:

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm run type-check` | Type-check without emitting build output. |
| `npm run lint` | Run ESLint with warnings treated as failures. |
| `npm run test:unit` | Run the unit tests from TypeScript source. |
| `npm run test:integration` | Run integration tests, including the real browser-backed renderer suite. |
| `npm run test:e2e` | Remove `dist/`, rebuild, and exercise the compiled MCP server. |
| `npm test` | Run the normal source-level suites and renderer suite; compiled output is not used. |
| `npm run test:all` | Remove `dist/`, rebuild, and run every suite, including e2e and renderer tests. |
| `npm run test:package` | Clean, build, pack, install, and initialize the published entry points in a temporary directory. |
| `npm run clean` | Remove generated `dist/` output. |
| `npm run check` | Run the clean contributor/CI gate: type-check, lint, clean build, and all tests. |

During development, run the narrowest relevant suite first. Before opening or
updating a pull request, run the same complete gates used by CI:

```bash
npm run clean
npm run check
npm run test:package
```

CI also runs `npm run audit:prod`. Dependency audit findings may require a
maintainer decision; do not weaken or bypass a check to make it pass.

### Generated and temporary files

`dist/` is generated build output and is intentionally ignored by Git. Do not
commit it. `npm run check`, `npm run test:all`, `npm run test:e2e`, and
`npm run test:package` clean stale output before compiling, so results cannot be
influenced by a previous build. Coverage output in `coverage/` is generated and
must not be committed either.

Tests and the package smoke check create isolated directories under the
operating system temporary directory and remove them afterward. The test user
therefore needs permission to create, read, and delete temporary files. Tests
that save diagrams set `MCP_BPMN_DIAGRAMS_PATH` to those isolated directories;
they must not write to the normal `~/mcp-bpmn` diagram directory. If a test
fails, verify that it preserves this isolation and cleans up in `afterEach` or
`afterAll`.

## Pull requests

1. Rebase or merge the current target branch into your focused branch and
   resolve conflicts deliberately.
2. Add or update tests and documentation with the implementation.
3. Run `npm run clean`, `npm run check`, and `npm run test:package`.
4. Review `git diff` and ensure generated output, credentials, local diagrams,
   and unrelated changes are absent.
5. Push your branch and open a pull request against the repository's target
   branch.
6. Explain the problem and solution, call out compatibility or security
   effects, and list the exact verification commands you ran.
7. Address review and CI feedback with focused follow-up commits.

A pull request does not grant authority to publish the package, create a tag or
GitHub release, deploy software, or change shared systems.

## Reporting security vulnerabilities

Do not disclose a suspected vulnerability in a public issue, discussion, or
pull request. Use **Report a vulnerability** on the repository's GitHub
**Security** tab to open a private security advisory for the maintainers. Include
the affected version or commit, reproduction steps, impact, and any suggested
mitigation. If private reporting is unavailable, contact a repository
maintainer privately and share only enough information to establish a secure
reporting channel.

## Versioning, changelog, and releases

The package follows Semantic Versioning. While the major version is `0`, the
public API is still evolving: backward-compatible fixes increment the patch
version, while features and breaking changes increment the minor version. Every
breaking change must be called out explicitly in the changelog and pull
request.

`package.json` is the source of truth for the package version; keep its lockfile
metadata in sync. A standalone `VERSION` file is not used. `CHANGELOG.md` keeps
an `Unreleased` section, and released entries must identify a repository tag so
their contents can be verified from Git history.

Repository maintainers own release decisions. Only they may select a version,
move `Unreleased` entries into a dated release section, update package metadata,
create a tag or GitHub release, publish to npm, or deploy. Contributors should
not include version bumps or release actions in ordinary pull requests unless a
maintainer explicitly requests them.
