import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "npm run build && BIUNIVERS_ADMIN_TOKEN=playwright-admin-token BIUNIVERS_DESKTOP_ORIGIN=http://127.0.0.1:4173 BIUNIVERS_APP_ORIGIN=http://127.0.0.1:4174 BIUNIVERS_DESKTOP_PORT=4173 BIUNIVERS_APP_PORT=4174 BIUNIVERS_DATA_DIR=/tmp/biunivers-playwright npm start",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
