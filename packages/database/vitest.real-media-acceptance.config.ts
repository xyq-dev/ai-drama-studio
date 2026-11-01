import { defineConfig } from "vitest/config";
/** Explicit opt-in only. Never collected by ordinary test or integration; always a new empty database. */
export default defineConfig({test:{environment:"node",include:["src/real-media.acceptance.spec.ts"],fileParallelism:false,testTimeout:30_000,hookTimeout:60_000}});
