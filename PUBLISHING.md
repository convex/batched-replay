# Publishing

In order for other people to install and use this component, you can publish the
package to npm.

You will first need to have an npmjs account with permissions to push to your
package name.

If this is your first time, here are the recommended steps:

1. Ensure the package.json "name" matches what you want it to be called. It
   should either be like `my-package` or `@my-org/my-package`. If it's the
   latter, ensure you have an npmjs account with permissions to push to
   `my-org`.
2. `npm login` to login to npmjs.
3. `npm ci` to install the dependencies with the versions specified in
   `package-lock.json`.
4. `npm run build:clean` to delete `/dist` and build the package fresh.
5. (Optional) `npm pack --dry-run` to list the files that will be published.
6. (Optional) `npm run typecheck` to typecheck the package.
7. (Optional) `npm run lint` to lint the package.
8. (Optional) `npm run test` to test the package.
9. (Optional) `npm pack` will create a .tgz file of the package. You can then
   try installing it in another project with
   `npm install ./path/to/your-package.tgz` to sanity check that it works as
   expected. You can remove the .tgz file after.
10. `npm publish --access public` to publish the package to npm. Do the first
    publish by hand like this, not with `npm run release`: `release` bumps the
    patch version first, so it would publish 0.1.1 instead of 0.1.0. A scoped
    package also needs `--access public` the first time.
11. `git tag v0.1.0` to tag the new version.
12. `git push --follow-tags` to push the tags to the repository. This way, other
    contributors can always see what code was published with each version.
    Running `npm version ...` will create these tags and commits automatically.

After the initial publish, you can use the release scripts documented below,
which will do steps 3-12 automatically (except the sanity check in step 9).

## Package scripts for releasing

In package.json, there are some scripts that are useful for doing releases.

- `preversion` will run the tests and typecheck the code before marking a new
  version.
- `version` will open the changelog in vim and then save it before committing
  the new version.
- `prepublishOnly` (`npm run build:clean`) will make a clean build of the
  package before publishing.

These are not required and can be modified or removed if desired. They will all
be run automatically when using one of the deployment commands.

## Deploying a new alpha version

```sh
npm run alpha
```

This will create a prerelease version with an `@alpha` tag. It will then publish
the package to npm and push the code and new tag. Users can install the package
with `npm install @your-package@alpha`.

## Deploying a new release version

```sh
npm run release
```

This will create a patch version and publish as `latest`. It will then publish
the package to npm and push the code and new tag. To publish a new minor or
major version, you can run the commands manually:

```sh
npm version minor # or major
npm publish
git push --follow-tags
```

## Building a one-off package

```sh
npm run build:clean
npm pack
```

You can then provide the .tgz file to others to install via
`npm install ./path/to/your-package.tgz`.

## The README's demo GIF

The README shows `docs/drawing-demo.gif` by a relative path, which GitHub
renders while the repo is private. npm and the Convex components directory
can't see a private repo's files, so once the repo is public, check the GIF
shows on the npm page and the directory listing. If it doesn't, switch the
image to its absolute URL:
`https://raw.githubusercontent.com/convex/batched-replay/main/docs/drawing-demo.gif`.
