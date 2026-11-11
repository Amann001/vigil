// Serves the built site (dist/) the way a static host such as GitHub Pages does: files as they
// are, and the site's page for any other address. With no API behind it, the war room plays
// its recorded replay.
//
//   npm run build && node scripts/serve-replay.mjs        # http://127.0.0.1:8040
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const PORT = Number(process.env.PORT ?? 8040);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

export function serve(port = PORT) {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
    let file = normalize(join(ROOT, path));
    if (!file.startsWith(normalize(ROOT))) return response.writeHead(403).end();
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // An address with an extension is a missing file; anything else is one of the pages.
      if (extname(path)) return response.writeHead(404).end();
      file = join(ROOT, "index.html");
    }
    response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  await serve();
  console.log(`Replay at http://127.0.0.1:${PORT}`);
}
