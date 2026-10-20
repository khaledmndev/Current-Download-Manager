import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    react(),
    {
      name: "current-local-development-bridge",
      configureServer(server) {
        server.middlewares.use("/__rpc", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end();
            return;
          }
          if (
            req.headers.origin !== "http://127.0.0.1:1420" ||
            !req.headers["content-type"]?.startsWith("application/json")
          ) {
            res.statusCode = 403;
            res.end();
            return;
          }
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 256 * 1024) req.destroy();
          });
          req.on("end", () => {
            try {
              const { operation, payload } = JSON.parse(body);
              const cli = fileURLToPath(
                new URL(
                  "../../target/x86_64-pc-windows-msvc/debug/current-cli.exe",
                  import.meta.url,
                ),
              );
              execFile(
                cli,
                ["rpc", String(operation), JSON.stringify(payload ?? null)],
                {
                  timeout: 20000,
                  maxBuffer: 16 * 1024 * 1024,
                  windowsHide: true,
                },
                (err, stdout, stderr) => {
                  res.setHeader("Content-Type", "application/json");
                  if (err) {
                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: stderr || err.message }));
                  } else res.end(stdout);
                },
              );
            } catch (e) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: String(e) }));
            }
          });
        });
      },
    },
  ],
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
  clearScreen: false,
});
