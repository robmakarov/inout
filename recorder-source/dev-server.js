#!/usr/bin/env node
/**
 * Serves this folder over http://127.0.0.1 — required for screen capture / MediaRecorder in Chrome.
 * file:// is a distinct opaque origin and triggers "Unsafe attempt to load URL file://..." and API failures.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname);
const PORT = Number(process.env.PORT) || 8765;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

function filePathFromUrl(urlPath) {
  const raw = decodeURIComponent((urlPath || "/").split("?")[0]);
  const relative = raw === "/" ? "index.html" : raw.replace(/^\//, "");
  const joined = path.normalize(path.join(root, relative));
  const relToRoot = path.relative(root, joined);
  if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
    return null;
  }
  return joined;
}

/** Forces relative hrefs (styles, scripts) to resolve to this HTTP origin — avoids file://-style resolution in embedded browsers. */
function injectHtmlBase(text, hostHeader) {
  const host = (hostHeader || "").trim() || `127.0.0.1:${PORT}`;
  const safeHost = host.replace(/[\s"<>]/g, "");
  const baseHref = `http://${safeHost}/`;
  return text.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    <base href="${baseHref}" />`);
}

function serveIndexHtml(req, res, fp) {
  fs.readFile(fp, "utf8", (readErr, text) => {
    if (readErr) {
      res.writeHead(500);
      res.end("Read error");
      return;
    }
    const body = Buffer.from(injectHtmlBase(text, req.headers.host), "utf8");
    res.setHeader("Content-Type", MIME[".html"]);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Length", body.length);
    res.writeHead(200);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(body);
  });
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  const fp = filePathFromUrl(req.url);
  if (!fp) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    if (path.basename(fp) === "index.html") {
      serveIndexHtml(req, res, fp);
      return;
    }
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(200);
    fs.createReadStream(fp).pipe(res);
  });
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the other process (or run: PORT=8770 npm start)`
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Serving on http://127.0.0.1:${PORT}/ and http://localhost:${PORT}/`);
  console.log("Open one of those URLs in Chrome — address bar must show http:// (never file://).");
});
