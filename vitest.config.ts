import { defineConfig } from "vitest/config";

// Dos proyectos: las pruebas de unidad no necesitan nada externo;
// las de integración necesitan el entorno de `pnpm dev:up` (Postgres + servidor de correo).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{apps,packages,plugins}/*/src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["{apps,packages,plugins}/*/test/**/*.integration.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
