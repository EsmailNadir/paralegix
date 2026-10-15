/**
 * A path-rewriting proxy in front of `fake-gcs-server`, for the benchmark only.
 *
 * The storage client is not consistent about where the JSON API lives when it
 * is pointed at a custom endpoint. An UPLOAD goes to
 * `<endpoint>/upload/storage/v1/b/<bucket>/o`, carrying the prefix itself. Every
 * other call goes to `<endpoint>/b/<bucket>/o/...`, without it. `fake-gcs-server`
 * serves only the prefixed form, so uploads succeed and every read that follows
 * one answers 404: the object is there, and the client is asking in the wrong
 * place. That failure is confusing precisely because the write worked.
 *
 * So this adds `/storage/v1` to everything except a path that already carries
 * it. It exists for the local benchmark harness and has no part in the product.
 *
 * Usage: `npx tsx scripts/gcs-path-proxy.ts --listen 4553 --upstream 4554`
 */
import http from 'http';

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const listenPort = Number(arg('--listen', '4553'));
const upstreamPort = Number(arg('--upstream', '4554'));
const upstreamHost = arg('--upstream-host', '127.0.0.1');

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const alreadyPrefixed = url.startsWith('/upload/') || url.startsWith('/storage/v1');
  const path = alreadyPrefixed ? url : `/storage/v1${url}`;

  const upstream = http.request(
    { host: upstreamHost, port: upstreamPort, path, method: req.method, headers: req.headers },
    (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    // Named, because a bare 502 here reads as a fault in the code under test.
    process.stderr.write(`gcs-path-proxy: ${req.method} ${path} failed: ${err.message}\n`);
    res.statusCode = 502;
    res.end(err.message);
  });
  req.pipe(upstream);
});

// A benchmark source is gigabytes, and every one of these defaults is a clock
// that would end the upload partway and report it as a gateway error.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 0;

server.listen(listenPort, () => {
  process.stdout.write(`gcs-path-proxy listening on ${listenPort} -> ${upstreamHost}:${upstreamPort}\n`);
});
