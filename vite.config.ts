import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { captionProApi } from "./server/api.ts";

export default defineConfig({
  plugins: [react(), captionProApi()],
  server: { watch: { ignored: ["**/data/**"] } },
});
