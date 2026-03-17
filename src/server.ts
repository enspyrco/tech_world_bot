import { createServer } from "node:http";

/**
 * Minimal HTTP health-check server for Cloud Run.
 *
 * Cloud Run requires a listening port to manage container lifecycle.
 * This server responds 200 to all requests — used for both health checks
 * and wake-up pings from the Cloud Function.
 */
export function startHealthServer(): void {
  const port = parseInt(process.env.PORT || "8080", 10);

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });

  server.listen(port, () => {
    console.log(`[Health] Listening on port ${port}`);
  });
}
