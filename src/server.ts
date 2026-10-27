import { createServer } from "node:http";

/**
 * Minimal HTTP health endpoint — responds 200 to every request.
 *
 * Written for Cloud Run (which needed a listening port) and the retired
 * Cloud Function's wake-up pings. On OCI nothing probes it today (the
 * tech-world-bots compose has no healthcheck); kept as a cheap liveness
 * target.
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
