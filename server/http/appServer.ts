import { join } from "node:path";
import express from "express";
import { requestHostMatchesApp } from "../apps/appOrigin.js";
import type { AppStore } from "../apps/appStore.js";

interface AppServerDependencies {
  appStore: AppStore;
  dataDir: string;
  appOrigin: string;
}

const APP_ID_PATTERN = /^[a-z0-9.-]+$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;
const BLOCKED_FILES = new Set([
  "biunivers.app.json",
  "BIUNIVERS_APP_PROTOCOL_V1.md",
]);

export function createAppServer(dependencies?: AppServerDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.set("X-Content-Type-Options", "nosniff");
    next();
  });

  app.get("/health", (_request, response) => {
    response.set("Cache-Control", "no-store").json({ status: "ok" });
  });

  if (dependencies) {
    app.use("/apps", async (request, response, next) => {
      try {
        const segments = request.path.split("/").filter(Boolean);
        if (segments.length < 2) {
          response.status(404).end();
          return;
        }
        const [commitSha, ...resourceSegments] = segments;
        if (!COMMIT_PATTERN.test(commitSha)) {
          response.status(404).end();
          return;
        }

        const state = await dependencies.appStore.read();
        const installed = state.apps.find(
          (record) =>
            record.status === "active" &&
            APP_ID_PATTERN.test(record.appId) &&
            requestHostMatchesApp(
              request.get("host"),
              dependencies.appOrigin,
              record.appId,
            ),
        );
        if (!installed) {
          response.status(404).end();
          return;
        }

        response.set("X-Content-Type-Options", "nosniff");
        response.set("Cross-Origin-Resource-Policy", "cross-origin");
        response.set("Referrer-Policy", "no-referrer");

        if (
          resourceSegments.length === 2 &&
          resourceSegments[0] === ".biunivers" &&
          resourceSegments[1] === "config.json"
        ) {
          response
            .set("Cache-Control", "no-store")
            .type("application/json")
            .send(`${JSON.stringify(installed.configuration, null, 2)}\n`);
          return;
        }

        if (
          resourceSegments.length === 0 ||
          resourceSegments.some(
            (segment) =>
              !segment ||
              segment === "." ||
              segment === ".." ||
              segment.startsWith("."),
          ) ||
          BLOCKED_FILES.has(resourceSegments.join("/"))
        ) {
          response.status(404).end();
          return;
        }

        const resource = resourceSegments.join("/");
        response.set(
          "Cache-Control",
          resource === "index.html"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        );
        response.sendFile(
          resource,
          {
            root: join(
              dependencies.dataDir,
              "apps",
              installed.appId,
              commitSha,
            ),
            dotfiles: "deny",
          },
          (error) => {
            if (error && !response.headersSent) {
              if ("statusCode" in error && error.statusCode === 404) {
                response.status(404).end();
              } else {
                next(error);
              }
            }
          },
        );
      } catch (error) {
        next(error);
      }
    });
  }

  app.use((_request, response) => {
    response.status(404).json({
      error: {
        code: "APP_NOT_FOUND",
        message: "应用资源不存在",
      },
    });
  });

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      console.error("App server request failed", error);
      if (!response.headersSent) {
        response.status(500).json({
          error: {
            code: "APP_READ_FAILED",
            message: "无法读取应用资源",
          },
        });
      }
    },
  );

  return app;
}
