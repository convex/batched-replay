# Publishing

See [CONTRIBUTING.md](CONTRIBUTING.md#releases) for the staged CI release flow.

## The README's demo GIF

The README shows `docs/drawing-demo.gif` by a relative path, which GitHub
renders while the repo is private. npm and the Convex components directory can't
see a private repo's files, so once the repo is public, check the GIF shows on
the npm page and the directory listing. If it doesn't, switch the image to its
absolute URL:
`https://raw.githubusercontent.com/convex/batched-replay/main/docs/drawing-demo.gif`.
