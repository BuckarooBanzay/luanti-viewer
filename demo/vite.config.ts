import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

/**
 * Demo app: serves the scene export (node definitions, mapblocks and media)
 * from the "export" directory at the root of the server.
 */
export default defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    // override with EXPORT_DIR to view another export
    publicDir: process.env.EXPORT_DIR ?? fileURLToPath(new URL("../export", import.meta.url)),
    // respond with 404 for missing files (mapblocks, media) instead of the index page
    appType: "mpa",
    server: {
        port: 5173,
        fs: {
            allow: [fileURLToPath(new URL("..", import.meta.url))]
        }
    },
    build: {
        outDir: fileURLToPath(new URL("../dist-demo", import.meta.url)),
        emptyOutDir: true
    }
})
