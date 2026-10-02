import "../global_setup";
import mongo from "../db";
import { get_sync_state } from "../sync_state";
import {
    get_owner_hres_id,
    get_subc_log_str,
    resolve_subc,
    missing_required_fields,
    build_vendor_payload,
    redact_payload,
} from "./subc";
import { load_owners, load_mappings } from "./sync";

// Read-only (npm run preview_vendors): shows what the sync would push for every subc - the
// resolved vendor fields (TIN redacted), what's missing, and whether it's linked. No
// QBO calls and no writes, so it's safe against any database. Pass --json for
// machine-readable output.

const as_json = process.argv.includes("--json");

async function main(): Promise<void> {
    await mongo.connect();
    try {
        const subcs = await mongo.get_subcs().find({}).sort({ name: 1 }).toArray();
        const owners = await load_owners(subcs);
        const mappings = await load_mappings(subcs.map((s) => s._id));
        const failures = get_sync_state().vendors.failures;

        const rows = subcs.map((sc) => {
            const owner_id = get_owner_hres_id(sc);
            const r = resolve_subc(sc, owner_id ? (owners.get(owner_id) ?? null) : null);
            const missing = missing_required_fields(r);
            const m = mappings.get(sc._id);
            return {
                subc: get_subc_log_str(sc),
                active: r.active,
                owner: owner_id ? (owners.has(owner_id) ? owner_id : `${owner_id} (not found)`) : null,
                linked_vendor: m?.qbo_id ?? null,
                failure: failures[sc._id]?.error ?? null,
                missing,
                vendor: missing.length === 0 ? redact_payload(build_vendor_payload(r)) : null,
            };
        });

        if (as_json) {
            console.log(JSON.stringify(rows, null, 2));
            return;
        }
        let ready = 0;
        for (const row of rows) {
            const status = row.linked_vendor
                ? `linked -> vendor ${row.linked_vendor}`
                : !row.active
                  ? "archived, no vendor (none will be created)"
                  : row.missing.length
                    ? `INCOMPLETE - missing ${row.missing.join(", ")}`
                    : "ready - will be created";
            if (row.active && !row.missing.length) ready++;
            ilog(
                `${row.subc}${row.active ? "" : " [archived]"}: ${status}${row.failure ? `  !! last failure: ${row.failure}` : ""}`
            );
            if (row.vendor) ilog(`    ${JSON.stringify(row.vendor)}`);
        }
        ilog(`\n${rows.length} subc(s); ${rows.filter((r) => r.active).length} active; ${ready} active and complete`);
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("[preview] Fatal error:", err);
    process.exit(1);
});
