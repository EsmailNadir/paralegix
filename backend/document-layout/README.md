# Shared document layout

Browser previews, PDF signing and document-worker pagination consume this one package.
`src/textFit.ts` and `src/textFitRich.ts` are pure measurement algorithms. The separately
DOM-typed `src/templateReflow.ts` exports a self-contained function serialized into preview
windows and Chromium. Keep every helper inside that function.

Both app manifests use local file dependencies. Clean development installs compile `dist/`
with the consuming application's TypeScript through `prepare`. Application build commands
always recompile it before the app build. `dist/` is generated and ignored by Git.

Backend Docker build stages copy this package before `npm ci`. Runtime stages copy the
compiled package from the build stage before installing production dependencies, so runtime
installs never need TypeScript. The document-worker's trimmed manifest includes this package.

Consumer text-fit suites cover line wrapping and rich styles. The frontend reflow suite
executes its serialized form against deterministic layout fixtures to protect preview/export
pagination and prevent closure dependencies.
