import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/** library build (dist/index.js) and unit tests, the demo has its own config in demo/ */
export default defineConfig({
    build: {
        lib: {
            entry: fileURLToPath(new URL("src/index.ts", import.meta.url)),
            formats: ["es"],
            fileName: "index"
        },
        rollupOptions: {
            // provided by the consuming application (peer dependency)
            external: [/^three($|\/)/]
        },
        sourcemap: true,
        emptyOutDir: true
    },
    test: {
        include: ["src/**/*.test.ts"],
        environment: "node"
    }
})
