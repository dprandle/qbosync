import "../global_setup";
import mongo from "../db";
import { config } from "../config";
import { qbo_client } from "../qbo/client";
import { make_ci_now } from "../uobj_common";
import { type qbo_vendor, find_vendor_by_display_name, update_vendor, get_vendor_log_str } from "./vendor_api";
import {
    get_subc_log_str,
    get_subc_owner,
    resolve_subc,
    missing_required_fields,
    build_vendor_payload,
    vendor_hash,
    redact_payload,
} from "./subc";
import { load_owners } from "./sync";
import { match_vendor, last4 } from "./vendor_match";
import { ask_yes_no } from "../util";

// Manual correction (npm run relink_vendor -- "<correct name>" "<wrong name>"): a subc ended
// up linked to the wrong QBO vendor, usually a duplicate the sync created because bootstrap
// didn't link the vendor accounting already had. Both vendors are found by exact
// DisplayName. Shows what it will do and asks before writing anything, then:
//   1. Points the subc's qbo_object_map entry at the correct vendor.
//   2. Makes the wrong vendor inactive (QBO can't delete vendors).
//   3. Pushes the subc's fields onto the correct vendor, as the sync does for a fresh
//      bootstrap link. The sync wouldn't get to it until the subc or its owner next
//      changed. This renames the correct vendor to the subc's DisplayName.
// Safe to re-run if a step fails part way. It doesn't touch sync_state.json, so it can run
// while the service is up.

// What QuickBooks adds to a name when the entity is made inactive, which frees the name.
const DELETED_SUFFIX = " (deleted)";

function same_name(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function find_exact(qbo: qbo_client, name: string): Promise<qbo_vendor | null> {
    const v = await find_vendor_by_display_name(qbo, name);
    return v && v.DisplayName === name ? v : null;
}

async function main(): Promise<void> {
    const [correct_name, wrong_name, ...rest] = process.argv.slice(2);
    if (!correct_name || !wrong_name || rest.length > 0 || correct_name === wrong_name) {
        elog('Usage: npm run relink_vendor -- "<correct vendor display name>" "<wrong vendor display name>"');
        process.exitCode = 1;
        return;
    }
    ilog(`[relink] QBO_ENV=${config.qbo_env}`);

    await mongo.connect();
    try {
        const qbo = new qbo_client();
        const map_col = mongo.get_qbo_map_objects();

        const correct = await find_exact(qbo, correct_name);
        if (!correct) throw new Error(`No QBO vendor has the display name "${correct_name}"`);
        // The suffixed name is for a re-run after step 2 already went through.
        const wrong = (await find_exact(qbo, wrong_name)) ?? (await find_exact(qbo, wrong_name + DELETED_SUFFIX));
        if (!wrong) throw new Error(`No QBO vendor has the display name "${wrong_name}"`);

        const [wrong_map, correct_map] = await Promise.all([
            map_col.findOne({ type: "vendor", qbo_id: wrong.Id }),
            map_col.findOne({ type: "vendor", qbo_id: correct.Id }),
        ]);
        if (wrong_map && correct_map) {
            throw new Error(
                `${get_vendor_log_str(correct)} is already linked to subc ${correct_map.our_id}, so it can't take over ` +
                    `the link from ${get_vendor_log_str(wrong)} (subc ${wrong_map.our_id})`
            );
        }
        const mapping = wrong_map ?? correct_map;
        if (!mapping) throw new Error("Neither vendor is linked to a subcontractor - nothing to correct");

        const sc = await mongo.get_subcs().findOne({ _id: mapping.our_id });
        if (!sc) throw new Error(`Subcontractor ${mapping.our_id} (mapping ${mapping._id}) not found`);
        const owner = get_subc_owner(sc, await load_owners([sc]));
        const label = get_subc_log_str(sc, owner);
        const r = resolve_subc(sc, owner);
        const payload = build_vendor_payload(r);
        const missing = missing_required_fields(r);
        const can_push = r.active && missing.length === 0;

        ilog(`[relink] Subcontractor ${label}${r.active ? "" : " [archived]"}`);
        if (wrong_map) {
            ilog(`[relink]   Relink:     ${get_vendor_log_str(wrong)} -> ${get_vendor_log_str(correct)}`);
        } else {
            ilog(`[relink]   Relink:     already linked to ${get_vendor_log_str(correct)}`);
        }
        ilog(`[relink]   Deactivate: ${get_vendor_log_str(wrong)}${wrong.Active ? "" : " - already inactive"}`);
        if (can_push) {
            ilog(
                `[relink]   Push:       ${get_vendor_log_str(correct)} gets the subc's fields:`,
                redact_payload(payload)
            );
        } else {
            const why = r.active ? `incomplete (missing ${missing.join(", ")})` : "archived";
            ilog(`[relink]   Push:       skipped, the subc is ${why}. The sync pushes on its next change.`);
        }
        const tin = match_vendor(sc, owner, correct)?.tin ?? "unknown";
        if (tin === "mismatch") {
            wlog(
                `[relink] WARNING: the TIN on ${get_vendor_log_str(correct)} (***${last4(correct.TaxIdentifier)}) ` +
                    `matches neither the owner's SSN nor the subc's EIN. Bootstrap would have ruled this vendor out.`
            );
        } else if (tin === "unknown") {
            ilog(`[relink]   The correct vendor's TIN can't be compared with ours (none on file on one side).`);
        }
        if (!(await ask_yes_no("[relink] Proceed?"))) {
            ilog("[relink] Nothing written.");
            return;
        }

        // 1. An empty synced_hash marks the link as never pushed, same as bootstrap.
        if (wrong_map) {
            const res = await map_col.updateOne(
                { _id: mapping._id, qbo_id: wrong.Id },
                {
                    $set: {
                        qbo_id: correct.Id,
                        synced_hash: "",
                        qbo_modified: new Date(correct.MetaData?.LastUpdatedTime ?? 0),
                        last_update: make_ci_now(),
                    },
                }
            );
            if (res.matchedCount !== 1)
                throw new Error(`Mapping ${mapping._id} changed underneath us - nothing written`);
            ilog(`[relink] Mapping ${mapping._id} now points at ${get_vendor_log_str(correct)}`);
        }

        // 2. The wrong vendor holds the DisplayName the correct one is about to get, and
        // names are unique across inactive vendors too. Rename it if deactivating didn't.
        let old = wrong;
        if (old.Active) {
            old = await update_vendor(qbo, old.Id, old.SyncToken, { Active: false });
            ilog(`[relink] Deactivated ${get_vendor_log_str(old)}`);
        }
        if (same_name(old.DisplayName, payload.DisplayName ?? "")) {
            old = await update_vendor(qbo, old.Id, old.SyncToken, { DisplayName: old.DisplayName + DELETED_SUFFIX });
            ilog(`[relink] Renamed it to free the name: ${get_vendor_log_str(old)}`);
        }

        // 3.
        if (!can_push) {
            ilog("[relink] Done. Push skipped (see above).");
            return;
        }
        const updated = await update_vendor(qbo, correct.Id, correct.SyncToken, payload);
        await map_col.updateOne(
            { _id: mapping._id },
            {
                $set: {
                    synced_hash: vendor_hash(payload),
                    qbo_modified: new Date(updated.MetaData?.LastUpdatedTime ?? Date.now()),
                    last_update: make_ci_now(),
                },
            }
        );
        ilog(`[relink] Updated ${get_vendor_log_str(updated)} for ${label}. Done.`);
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("[relink] Failed:", err);
    process.exit(1);
});
