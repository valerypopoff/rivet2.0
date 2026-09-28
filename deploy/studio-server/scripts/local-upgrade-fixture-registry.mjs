import http from 'node:http';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

function tarFile(name, contents) {
  const bytes = Buffer.from(contents);
  const header = Buffer.alloc(512);
  header.write(name);
  for (const [offset, length, value] of [
    [100, 8, 0o644],
    [108, 8, 0],
    [116, 8, 0],
    [124, 12, bytes.length],
    [136, 12, 0],
  ])
    header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)]);
}
export function fixturePackage(version) {
  const entry = version === '1.0.0' ? 'first.cjs' : 'second.cjs';
  return gzipSync(
    Buffer.concat([
      tarFile('package/package.json', JSON.stringify({ name: 'example', version, main: entry, exports: `./${entry}` })),
      tarFile(`package/${entry}`, `module.exports=${version === '1.0.0' ? 42 : 84};`),
      Buffer.alloc(1024),
    ]),
  );
}
export function createFixtureRegistry() {
  return http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    const versions = ['1.0.0', '2.0.0'];
    if (req.url === '/example') {
      const entries = Object.fromEntries(
        versions.map((version) => {
          const bytes = fixturePackage(version);
          return [
            version,
            {
              name: 'example',
              version,
              dist: {
                tarball: `http://fixture-registry:4873/example/-/example-${version}.tgz`,
                integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
              },
            },
          ];
        }),
      );
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ name: 'example', 'dist-tags': { latest: '2.0.0' }, versions: entries }));
      return;
    }
    for (const version of versions)
      if (req.url === `/example/-/example-${version}.tgz`) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(fixturePackage(version));
        return;
      }
    res.writeHead(404).end();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  createFixtureRegistry().listen(4873, '0.0.0.0');
