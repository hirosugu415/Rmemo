import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The read-only web viewer (PWA) in `web/`, sharing the editor/Markdown code
// in `src/`. Published to GitHub Pages at https://hirosugu415.github.io/Rmemo/app/
// by .github/workflows/pages.yml, under the landing page in `site/`.
export default defineConfig(({ command }) => ({
  root: "web",
  base: command === "build" ? "/Rmemo/app/" : "/",
  plugins: [react()],
  build: {
    outDir: "../dist-web/app",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
}));
