import "../global_setup";
import mongo from "../db";
import { config } from "../config";
import { qbo_client } from "../qbo/client";
import { create_qbo_object_map_item } from "../qbo/object_map";
import { make_ci_now } from "../uobj_common";
import { find_vendor_by_display_name, get_vendor_log_str } from "./vendor_api";
import {
    get_subc_log_str,
    get_subc_owner,
    resolve_subc,
    missing_required_fields,
    build_vendor_payload,
    vendor_hash,
    redact_payload,
} from "./subc";
import { load_owners, load_mappings, process_subc } from "./sync";
import { match_vendor, get_vendor_tin_status, last4 } from "./vendor_match";
import { ask_yes_no } from "../util";

// Manual link (npm run link_vendor -- "<vendor display name>" <subc id>): ties a subc to a
// QBO vendor found by exact DisplayName. Shows what it will do and asks before each step:
//   1. Points the vendor's qbo_object_map entry at the subc, creating the entry if the vendor
//      has none. The subc that had the vendor is left unlinked, so the sync's orphan sweep
//      treats it like any other subc without a vendor.
//   2. Runs the vendor sync for this subc only. This renames the vendor to the subc's
//      DisplayName, or deactivates it if the subc is archived.
// Refuses a subc already linked to a different vendor: that's what relink_vendor is for.
// Safe to re-run if a step fails part way. Can run while the service is up: sync_state.json
// is only written if this subc has a recorded failure or gets a new one, and the service
// keeps its own copy.

async function main(): Promise<void> {
    const [vendor_name, subc_id, ...rest] = process.argv.slice(2);
    if (!vendor_name || !subc_id || rest.length > 0) {
        elog('Usage: npm run link_vendor -- "<vendor display name>" <subc id>');
        process.exitCode = 1;
        return;
    }
    ilog(`[link] QBO_ENV=${config.qbo_env}`);

    await mongo.connect();
    try {
        const qbo = new qbo_client();
        const map_col = mongo.get_qbo_map_objects();

        const sc = await mongo.get_subcs().findOne({ _id: subc_id });
        if (!sc) throw new Error(`No subcontractor has the id ${subc_id}`);
        const found = await find_vendor_by_display_name(qbo, vendor_name);
        const vendor = found?.DisplayName === vendor_name ? found : null;
        if (!vendor) throw new Error(`No QBO vendor has the display name "${vendor_name}"`);

        const owners = await load_owners([sc]);
        const owner = get_subc_owner(sc, owners);
        const label = get_subc_log_str(sc, owner);
        const vendor_str = get_vendor_log_str(vendor);

        const [subc_map, vendor_map] = await Promise.all([
            map_col.findOne({ type: "vendor", our_id: sc._id }),
            map_col.findOne({ type: "vendor", qbo_id: vendor.Id }),
        ]);
        if (subc_map && subc_map.qbo_id !== vendor.Id) {
            throw new Error(
                `${label} is already linked to vendor ${subc_map.qbo_id} (mapping ${subc_map._id}). ` +
                    `Use npm run relink_vendor to move it.`
            );
        }

        const r = resolve_subc(sc, owner);
        const payload = build_vendor_payload(r);
        const hash = vendor_hash(payload);
        const missing = missing_required_fields(r);
        const will_push = r.active && missing.length === 0;

        ilog(`[link] Subcontractor ${label}${r.active ? "" : " [archived]"}`);
        ilog(`[link] Vendor ${vendor_str}`);
        const tin = get_vendor_tin_status(sc, owner, vendor);
        if (tin === "mismatch") {
            wlog(
                `[link] WARNING: the TIN on ${vendor_str} (***${last4(vendor.TaxIdentifier)}) matches neither ` +
                    `the owner's SSN nor the subc's EIN.`
            );
        } else if (tin === "unknown") {
            ilog(`[link] The vendor's TIN can't be compared with ours (none on file on one side).`);
        }
        if (!match_vendor(sc, owner, vendor)) {
            wlog(`[link] WARNING: no name on ${vendor_str} matches the subc or its owner.`);
        }

        // 1. An empty synced_hash marks the link as never pushed, same as bootstrap, which
        // is what makes the sync below write to the vendor.
        if (subc_map) {
            ilog(`[link] Mapping ${subc_map._id} already points at this vendor.`);
        } else {
            if (vendor_map) {
                ilog(`[link] Change mapping ${vendor_map._id}: subc ${vendor_map.our_id} -> ${label}`);
                ilog(`[link] That leaves subc ${vendor_map.our_id} unlinked. If it's active and complete, the`);
                ilog(`[link] sync's next pass tries to create it a vendor.`);
            } else {
                ilog(`[link] Create a mapping: ${label} -> ${vendor_str}`);
            }
            const question = vendor_map
                ? `[link] Write this mapping (takes the place of subc ${vendor_map.our_id})?`
                : "[link] Write this mapping?";
            if (!(await ask_yes_no(question))) {
                ilog("[link] Nothing written.");
                return;
            }
            const qbo_modified = new Date(vendor.MetaData?.LastUpdatedTime ?? 0);
            if (vendor_map) {
                const res = await map_col.updateOne(
                    { _id: vendor_map._id, our_id: vendor_map.our_id },
                    { $set: { our_id: sc._id, synced_hash: "", qbo_modified, last_update: make_ci_now() } }
                );
                if (res.matchedCount !== 1) {
                    throw new Error(`Mapping ${vendor_map._id} changed underneath us - nothing written`);
                }
            } else {
                const created = create_qbo_object_map_item(vendor.Id, sc._id, "vendor", qbo_modified, "");
                await map_col.insertOne(created);
            }
            ilog(`[link] Mapping written: ${label} -> ${vendor_str}`);
        }

        // 2. process_subc won't touch the vendor in these two cases, so don't ask.
        if (subc_map && subc_map.synced_hash === hash) {
            ilog("[link] The vendor already has the subc's current fields. Done.");
            return;
        }
        if (r.active && missing.length > 0) {
            ilog(`[link] Sync skipped, the subc is incomplete (missing ${missing.join(", ")}).`);
            ilog("[link] The sync pushes on its next change. Done.");
            return;
        }

        if (will_push) {
            ilog(`[link] Sync: ${vendor_str} gets the subc's fields:`, redact_payload(payload));
            const holder = await find_vendor_by_display_name(qbo, payload.DisplayName ?? "");
            if (holder && holder.Id !== vendor.Id) {
                wlog(
                    `[link] WARNING: ${get_vendor_log_str(holder)} already has the DisplayName the sync will push, ` +
                        `so QBO will reject it until that vendor is renamed.`
                );
            }
        } else if (vendor.Active) {
            ilog(`[link] Sync: the subc is archived, so ${vendor_str} gets DEACTIVATED.`);
        } else {
            ilog(`[link] Sync: the subc is archived and the vendor is already inactive, so QBO isn't changed.`);
        }
        if (!(await ask_yes_no("[link] Run the vendor sync for this subc?"))) {
            ilog("[link] Sync not run. The sync pushes on the subc's or its owner's next change.");
            return;
        }

        // process_subc records and alerts on a permanent QBO rejection instead of throwing,
        // so check the mapping to see whether the sync went through.
        const ctx = { qbo, owners, mappings: await load_mappings([sc._id]) };
        await process_subc(sc, ctx, false);
        const after = await map_col.findOne({ type: "vendor", our_id: sc._id });
        if (after?.qbo_id !== vendor.Id || after.synced_hash !== hash) {
            elog(`[link] The sync didn't update ${vendor_str} (see above). Fix the cause and re-run.`);
            process.exitCode = 1;
            return;
        }
        ilog(`[link] Synced ${label} to ${vendor_str}. Done.`);
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("[link] Failed:", err);
    process.exit(1);
});
