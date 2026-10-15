// Stub used to exclude the optional Node-only `canvas` package (pulled in by
// pdfjs-dist / react-pdf) from the browser bundle under Turbopack. Mirrors the
// webpack `resolve.alias.canvas = false` used for the production build.
export {};
