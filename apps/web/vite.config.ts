import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ortha/web — standalone chat console wired to a mock transport.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
