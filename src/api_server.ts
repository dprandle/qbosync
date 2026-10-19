import Fastify, { FastifyInstance } from "fastify";
import { config } from "./config";
import { oauth_routes } from "./qbo/oauth_routes";
import { vendor_routes } from "./vendors/vendor_routes";

// Loopback-only API, like qbtsync's invite server. zetrick-api on the same droplet is
// the public edge: it authenticates callers (Intuit's redirect, Uber) and forwards
// to these routes, so nothing here is reachable from outside and no route needs its
// own auth. Each feature registers its routes under its own prefix; add new ones
// (e.g. app.register(expense_routes, { prefix: "/expenses" })) the same way.
const HOST = "127.0.0.1";

export async function start_api_server(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });

    await app.register(oauth_routes, { prefix: "/oauth" });
    await app.register(vendor_routes, { prefix: "/vendors" });

    await app.listen({ host: HOST, port: config.api_server_port });
    ilog(`[api] Listening on http://${HOST}:${config.api_server_port}`);
    return app;
}
