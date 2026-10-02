import { FastifyInstance } from "fastify";
import { create_connect_url, complete_oauth, get_connection_status, type oauth_callback_params } from "./auth";

// OAuth routes behind zetrick-api's public /quickbooks, /quickbooks/connect and
// /quickbooks/callback. All OAuth logic and secrets stay here; zetrick-api just
// renders the HTML. Registered under the /oauth prefix by api_server.ts.

const callback_body_schema = {
    type: "object",
    additionalProperties: false,
    properties: {
        code: { type: "string" },
        state: { type: "string" },
        realmId: { type: "string" },
        error: { type: "string" },
        error_description: { type: "string" },
    },
} as const;

export async function oauth_routes(app: FastifyInstance): Promise<void> {
    // The Intuit authorize URL (with a fresh single-use state) for zetrick-api to
    // redirect the browser to.
    app.get("/connect_url", async () => ({ url: create_connect_url() }));

    // zetrick-api passes Intuit's callback query through as the body.
    app.post<{ Body: oauth_callback_params }>(
        "/callback",
        { schema: { body: callback_body_schema } },
        async (req, reply) => {
            const result = await complete_oauth(req.body ?? {});
            return reply.code(result.ok ? 200 : result.status).send(result);
        }
    );

    app.get("/status", async () => get_connection_status());
}
