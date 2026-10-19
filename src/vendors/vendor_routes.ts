import { FastifyInstance } from "fastify";
import mongo from "../db";
import { qbo_client, qbo_api_error } from "../qbo/client";
import { qbo_not_connected_error } from "../qbo/auth";
import { get_vendor } from "./vendor_api";

// Vendor routes behind zetrick-api's /quickbooks/vendors/*, which authenticates Uber
// and relays the status and body back unchanged. Registered under the /vendors prefix
// by api_server.ts.

const qbo = new qbo_client();

export async function vendor_routes(app: FastifyInstance): Promise<void> {
    // The QBO vendor linked to a subcontractor. 404 when the subc has no vendor yet
    // (not synced, incomplete, or rejected) or its mapping points at a vendor that no
    // longer exists; cleanup removes stale mappings on its next pass.
    app.get<{ Params: { subc_id: string } }>("/by_subc/:subc_id", async (req, reply) => {
        const { subc_id } = req.params;
        try {
            const mapping = await mongo.get_qbo_map_objects().findOne({ type: "vendor", our_id: subc_id });
            if (!mapping) {
                return reply.code(404).send({ message: `No QuickBooks vendor linked to subcontractor ${subc_id}` });
            }
            const vendor = await get_vendor(qbo, mapping.qbo_id);
            if (!vendor) {
                return reply.code(404).send({ message: `QuickBooks vendor ${mapping.qbo_id} no longer exists` });
            }
            return vendor;
        } catch (err) {
            if (err instanceof qbo_not_connected_error) {
                return reply.code(503).send({ message: err.message });
            }
            elog(`[api] Vendor lookup for subc ${subc_id} failed: ${err}`);
            const status = err instanceof qbo_api_error ? 502 : 500;
            return reply.code(status).send({ message: String(err instanceof Error ? err.message : err) });
        }
    });
}
