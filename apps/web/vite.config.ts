import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// En desarrollo la interfaz corre en el puerto 5173 y pasa /api al servidor.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.PORT ?? 3000}`, changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
