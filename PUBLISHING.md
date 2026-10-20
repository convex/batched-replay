# Publishing

Releases are published to npm by GitHub Actions when a version tag is pushed
(`.github/workflows/publish.yml`). It authenticates with
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers), so there's
no npm token stored anywhere, and npm adds a provenance statement linking each
version to the commit and workflow run that built it (for a public repo).

## One-time setup

npm only lets you set up Trusted Publishing on a package that already exists, so
the very first version is published by hand.

1. Make the GitHub repo public (provenance and the components directory both
   need it).
2. Publish 0.1.0 from a clean checkout of `main`, as someone with publish rights
   on the `@convex-dev` npm scope:

   ```sh
   npm login
   npm ci
   npm publish --access public
   ```

   `prepublishOnly` makes a clean build first. Don't use `npm run release` for
   this one: it bumps the version first, so it would publish 0.1.1.

3. Tag it, so the repo records what was published:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

   The publish workflow runs, sees 0.1.0 is already on npm, and stops without
   publishing.

4. On npmjs.com, open `@convex-dev/batched-replay`, go to **Settings**, and
   under **Trusted Publisher** choose **GitHub Actions** with:
   - Organization or user: `convex`
   - Repository: `batched-replay`
   - Workflow filename: `publish.yml`
   - Environment: leave blank

5. Optional but recommended: in the same settings, under **Publishing access**,
   choose "Require two-factor authentication and disallow tokens", so only the
   workflow (or a person with 2FA) can publish.

## Releasing a new version

From an up-to-date `main`:

```sh
npm run release   # patch: 0.1.0 -> 0.1.1
```

For a minor or major version:

```sh
npm version minor # or major
git push --follow-tags
```

For a prerelease, published under the `alpha` dist-tag rather than `latest`:

```sh
npm run alpha     # 0.1.1 -> 0.1.2-alpha.0
```

Users install those with `npm install @convex-dev/batched-replay@alpha`.

Each of these runs the `preversion` checks (a clean install, build with codegen,
tests, lint and typecheck), opens CHANGELOG.md in vim for the release notes (the
`version` script), commits, tags and pushes. The pushed tag starts the publish
workflow, which checks the tag matches `package.json`, builds, tests, typechecks
and lints again, then publishes. Watch it in the repo's Actions tab.

## Before a release

- `npm pack --dry-run` lists exactly what will be published (`dist`, `src`
  without tests, README, LICENSE and CHANGELOG).
- To try the package somewhere else first: `npm pack`, then
  `npm install ./convex-dev-batched-replay-<version>.tgz` in another project.

## Publishing by hand (if CI is down)

```sh
npm login
npm ci
npm publish --access public   # add --tag alpha for a prerelease
git push --follow-tags
```

## The README's demo GIF

The README shows `docs/drawing-demo.gif` by a relative path, which GitHub
renders while the repo is private. npm and the Convex components directory can't
see a private repo's files, so once the repo is public, check the GIF shows on
the npm page and the directory listing. If it doesn't, switch the image to its
absolute URL:
`https://raw.githubusercontent.com/convex/batched-replay/main/docs/drawing-demo.gif`.
