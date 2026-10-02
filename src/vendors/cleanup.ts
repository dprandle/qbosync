import mongo from "../db";
import { qbo_client } from "../qbo/client";
import { fetch_vendors_by_ids, update_vendor, get_vendor_log_str } from "./vendor_api";
import { get_sync_state } from "../sync_state";
import { clear_vendor_failure } from "./failures";
import { process_subc, load_owners, load_mappings } from "./sync";
import { get_subc_log_str } from "./subc";

// Safety net for what the delta loop structurally can't see (same policy as
// qbtsync's cleanup):
//   - Vendor missing in QBO: drop the mapping. The orphan sweep recreates the vendor
//     on the next pass if the subc still needs one.
//   - Subc hard-deleted (moved to subcontractor-deleted): deactivate its vendor, then
//     drop the mapping. QBO can't delete vendors, only make them inactive.
// It also retries every recorded permanent failure once, so a conflict fixed on the
// QBO side (say, a customer renamed) is picked up without anyone touching the subc.
// Runs inside the single sync loop, so nothing else is mutating the map concurrently.

const CHUNK = 100;

async function cleanup_mappings(qbo: qbo_client): Promise<void> {
    const map_col = mongo.get_qbo_map_objects();
    const maps = await map_col.find({ type: "vendor" }).toArray();
    let removed = 0;
    let deactivated = 0;

    for (let i = 0; i < maps.length; i += CHUNK) {
        const batch = maps.slice(i, i + CHUNK);
        try {
            const [vendors, subcs] = await Promise.all([
                fetch_vendors_by_ids(
                    qbo,
                    batch.map((m) => m.qbo_id)
                ),
                mongo
                    .get_subcs()
                    .find({ _id: { $in: batch.map((m) => m.our_id) } }, { projection: { _id: 1 } })
                    .toArray(),
            ]);
            const vendor_by_id = new Map(vendors.map((v) => [v.Id, v]));
            const subc_ids = new Set(subcs.map((s) => s._id));

            for (const m of batch) {
                const vendor = vendor_by_id.get(m.qbo_id);
                const subc_present = subc_ids.has(m.our_id);
                if (vendor && subc_present) continue;
                try {
                    if (vendor && vendor.Active) {
                        await update_vendor(qbo, vendor.Id, vendor.SyncToken, { Active: false });
                        ilog(`[cleanup] Deactivated ${get_vendor_log_str(vendor)} - subc ${m.our_id} was deleted`);
                        deactivated++;
                    }
                    await map_col.deleteOne({ _id: m._id });
                    removed++;
                    ilog(
                        `[cleanup] Dropped mapping ${m._id} (vendor ${m.qbo_id} ${vendor ? "present" : "missing"}, subc ${m.our_id} ${subc_present ? "present" : "missing"})`
                    );
                } catch (err) {
                    elog(`[cleanup] Failed to clean up mapping ${m._id}:`, err);
                }
            }
        } catch (err) {
            elog(`[cleanup] Failed to probe a batch of ${batch.length} mappings - skipping:`, err);
        }
    }
    ilog(`[cleanup] Scanned ${maps.length} mapping(s): removed ${removed}, deactivated ${deactivated} vendor(s)`);
}

async function retry_failures(qbo: qbo_client): Promise<void> {
    const ids = Object.keys(get_sync_state().vendors.failures);
    if (ids.length === 0) return;
    ilog(`[cleanup] Retrying ${ids.length} recorded vendor failure(s)`);

    const subcs = await mongo
        .get_subcs()
        .find({ _id: { $in: ids } })
        .toArray();
    const found = new Set(subcs.map((s) => s._id));
    for (const id of ids) if (!found.has(id)) clear_vendor_failure(id);

    const ctx = { qbo, owners: await load_owners(subcs), mappings: await load_mappings(ids) };
    for (const sc of subcs) {
        try {
            await process_subc(sc, ctx, false);
        } catch (err) {
            elog(`[cleanup] Retry of ${get_subc_log_str(sc)} failed transiently:`, err);
        }
    }
}

export async function run_vendor_cleanup(qbo: qbo_client): Promise<void> {
    ilog("[cleanup] Starting qbo object map cleanup");
    await cleanup_mappings(qbo);
    await retry_failures(qbo);
    ilog("[cleanup] Finished");
}
