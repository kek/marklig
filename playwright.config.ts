import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:1420",
    trace: "retain-on-failure",
  },

  // The dev server the specs drive. Every spec used to start its own with
  // `spawn("npm", ["run", "dev"], { detached: true })` in `beforeAll` and stop
  // it with `process.kill(-pid)` in `afterAll`. Both halves of that are
  // Unix-only:
  //
  //   * `spawn("npm", …)` without a shell needs a file literally named `npm`.
  //     On Windows there is only `npm.cmd`, so the spawn fails ENOENT — and an
  //     unhandled 'error' event on a ChildProcess is an uncaught exception,
  //     which takes the whole Playwright worker with it.
  //   * `process.kill(-pid)` addresses a process *group*, which Windows does
  //     not have; the call throws (and was swallowed), leaving vite holding
  //     port 1420.
  //
  // Neither had ever been exercised: the workflow triggered on a branch that
  // does not exist, so `playwright test` had never run on any runner. Handing
  // the server to Playwright's own `webServer` fixes both — it shells out
  // portably and tears down the whole process tree via taskkill on Windows —
  // and starts vite once for the run instead of eleven times, which is most of
  // what the suite's wall-clock was.
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    // Locally, reuse a dev server you already have open. In CI insist on our
    // own, so a leaked server can never make the run look green.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
