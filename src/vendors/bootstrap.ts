import "../global_setup";
import mongo from "../db";
import { config } from "../config";
import { ensure_state_file_writable, get_sync_state, save_vendor_state } from "../sync_state";
import { create_qbo_object_map_item, type qbo_object_map } from "../qbo/object_map";
import { qbo_client } from "../qbo/client";
import { fetch_all_vendors, get_vendor_log_str, type qbo_vendor } from "./vendor_api";
import { is_active } from "../uobj_common";
import { type subc_doc, get_owner_hres_id, get_subc_log_str, resolve_subc } from "./subc";
import { load_owners } from "./sync";
import {
    MATCH_OWNER_FIELDS,
    MATCH_NAME,
    MATCH_LOOSE,
    MATCH_TIN_ONLY,
    type vendor_match,
    type subc_candidates,
    match_vendors,
    find_auto_links,
    is_plausible,
    last4,
} from "./vendor_match";
import { ask_yes_no, ask_choice } from "../util";

// One-time bootstrap (npm run bootstrap_vendors): link the vendors already in QuickBooks to
// our subcontractors so the sync doesn't create duplicates of them. Run it after
// QuickBooks is connected and before the sync starts (the service idles until this
// sets bootstrap_complete). Re-running skips subcs/vendors that are already linked.
//
// See vendor_match.ts for what counts as a match. A vendor whose visible TIN matches
// neither the owner's SSN nor the subc's EIN is ruled out and logged. Then, in order:
//   1. One plausible vendor, exact name + TIN last-4, and no other subc wants it
//      -> linked automatically, active subcs first so they win a vendor an archived
//      subc also matches. Going first means the prompts below don't offer vendors that
//      are already spoken for.
//   2. Any name match -> asks y/n, or which one if there are several, listing every
//      plausible vendor including last-4-only ones
//   3. 1099 vendors with only the last-4 in common -> asks the same way
//   4. Nothing -> left for the sync to create once complete
// Plausible candidates left over once a subc is linked are logged as possible
// duplicates. Unlike qbtsync's bootstrap, unlinked vendors are only listed, never
// archived: most vendors in the books (suppliers, utilities) have nothing to do with
// subcs, and a duplicate's payment history is accounting's to sort out.
//
// New links get an empty synced_hash, so the first sync pass pushes our data
// (DisplayName, TIN, address, Vendor1099) onto every linked vendor.
//
// Flags: --dry-run  match and log only; write nothing and leave the flag unset.

const dry_run = process.argv.includes("--dry-run");

const RANK_LABELS: Record<number, string> = {
    [MATCH_OWNER_FIELDS]: "owner name on vendor name fields",
    [MATCH_NAME]: "exact name",
    [MATCH_LOOSE]: "similar name",
    [MATCH_TIN_ONLY]: "no name match",
};

const TIN_LABELS: Record<vendor_match["tin"], string> = {
    match: "TIN last-4 matches",
    unknown: "TIN can't be compared",
    mismatch: "TIN last-4 differs",
};

function describe_match(m: vendor_match): string {
    const v = m.vendor;
    const details = [
        RANK_LABELS[m.rank],
        `${TIN_LABELS[m.tin]} (***${last4(v.TaxIdentifier) || "----"})`,
        v.Active ? "active" : "inactive",
        v.Vendor1099 ? "1099" : "not 1099",
    ];
    return `vendor "${v.DisplayName}" (${v.Id}) [${details.join(", ")}]`;
}

type bootstrap_row = subc_candidates & {
    active: boolean;
    label: string;
};

async function main(): Promise<void> {
    ensure_state_file_writable();
    if (get_sync_state().vendors.bootstrap_complete) {
        ilog("[bootstrap] Already complete - nothing to do. (`npm run reset` clears the flag.)");
        return;
    }
    ilog(`[bootstrap] QBO_ENV=${config.qbo_env}${dry_run ? " (dry run - no writes)" : ""}`);

    await mongo.connect();
    try {
        await mongo.ensure_indexes();
        const qbo = new qbo_client();
        const map_col = mongo.get_qbo_map_objects();

        const vendors = await fetch_all_vendors(qbo);
        const subcs = await mongo.get_subcs().find({}).toArray();
        const owners = await load_owners(subcs);
        ilog(`[bootstrap] ${vendors.length} QBO vendor(s), ${subcs.length} subcontractor(s)`);

        const existing = await map_col.find({ type: "vendor" }).toArray();
        const linked_subcs = new Map(existing.map((m) => [m.our_id, m.qbo_id]));
        const linked_vendors = new Set(existing.map((m) => m.qbo_id));
        const open_vendors = vendors.filter((v) => !linked_vendors.has(v.Id));

        // Active subcs first so they win a vendor two subcs both match. Already linked
        // subcs stay in the list so their possible duplicates get reported.
        const rows: bootstrap_row[] = [...subcs]
            .sort((a, b) => Number(!is_active(a.archived_info.on)) - Number(!is_active(b.archived_info.on)))
            .map((sc) => {
                const owner_id = get_owner_hres_id(sc);
                const owner = owner_id ? (owners.get(owner_id) ?? null) : null;
                const r = resolve_subc(sc, owner);
                return {
                    sc,
                    active: r.active,
                    label: `${get_subc_log_str(sc, owner)} [${r.display_name}${r.active ? "" : ", archived"}]`,
                    matches: match_vendors(sc, owner, open_vendors),
                };
            });

        const inserts: qbo_object_map[] = [];
        const link = (sc: subc_doc, pick: qbo_vendor): void => {
            linked_subcs.set(sc._id, pick.Id);
            linked_vendors.add(pick.Id);
            inserts.push(
                create_qbo_object_map_item(pick.Id, sc._id, "vendor", new Date(pick.MetaData?.LastUpdatedTime ?? 0), "")
            );
        };
        const still_open = (row: bootstrap_row, keep: (m: vendor_match) => boolean): vendor_match[] =>
            row.matches.filter((m) => keep(m) && !linked_vendors.has(m.vendor.Id));
        const label_of = new Map(rows.map((row) => [row.sc._id, row.label]));

        for (const row of rows) {
            if (linked_subcs.has(row.sc._id)) continue;
            for (const m of row.matches) {
                if (!is_plausible(m)) {
                    wlog(`[bootstrap] Ruled out for ${row.label}: ${describe_match(m)}`);
                }
            }
        }

        // Fresh matches per group, so an active subc's link is off the table before the
        // archived subcs are considered.
        for (const active of [true, false]) {
            const group = rows
                .filter((row) => row.active === active && !linked_subcs.has(row.sc._id))
                .map((row) => ({ sc: row.sc, matches: still_open(row, () => true) }));
            for (const { sc, match } of find_auto_links(group)) {
                ilog(`[bootstrap] ${label_of.get(sc._id)} -> ${describe_match(match)}`);
                link(sc, match.vendor);
            }
        }

        const ask_link = async (row: bootstrap_row, cands: vendor_match[]): Promise<void> => {
            let pick: vendor_match | null = null;
            if (cands.length === 1) {
                if (await ask_yes_no(`[bootstrap] Link ${row.label} to ${describe_match(cands[0])}?`)) {
                    pick = cands[0];
                }
            } else if (cands.length > 1) {
                const i = await ask_choice(
                    `[bootstrap] ${row.label} matches ${cands.length} vendors:`,
                    cands.map(describe_match)
                );
                if (i >= 0) pick = cands[i];
            }
            if (pick) link(row.sc, pick.vendor);
        };

        for (const row of rows) {
            if (linked_subcs.has(row.sc._id)) continue;
            const cands = still_open(row, is_plausible);
            if (cands.some((m) => m.rank !== MATCH_TIN_ONLY)) await ask_link(row, cands);
        }

        // Last, so the last-4 alone (not much evidence) is only offered once the name
        // matches have claimed what they can. A subc declined above still has its name
        // match open, so it isn't asked twice.
        for (const row of rows) {
            if (linked_subcs.has(row.sc._id)) continue;
            const cands = still_open(row, is_plausible);
            if (cands.every((m) => m.rank === MATCH_TIN_ONLY)) await ask_link(row, cands);
        }

        for (const row of rows) {
            const linked_to = linked_subcs.get(row.sc._id);
            if (!linked_to) continue;
            for (const m of still_open(row, is_plausible)) {
                wlog(`[bootstrap] Possible duplicate for ${row.label}, linked to ${linked_to}: ${describe_match(m)}`);
            }
        }
        for (const row of rows) {
            if (row.active && !linked_subcs.has(row.sc._id)) {
                ilog(`[bootstrap] No vendor for active ${row.label} - the sync will create one once it's complete`);
            }
        }
        for (const v of vendors) {
            if (!linked_vendors.has(v.Id) && v.Vendor1099) {
                ilog(`[bootstrap] Unlinked 1099 ${get_vendor_log_str(v)} - review in QuickBooks`);
            }
        }

        ilog(`[bootstrap] ${inserts.length} new link(s)`);
        if (dry_run) {
            ilog("[bootstrap] Dry run - nothing written.");
            return;
        }
        if (inserts.length > 0) {
            await mongo.with_transaction((session) => map_col.insertMany(inserts, { session }).then(() => undefined));
        }
        save_vendor_state({ bootstrap_complete: true });
        ilog("[bootstrap] Complete. The running service will start syncing on its next tick.");
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("[bootstrap] Fatal error:", err);
    process.exit(1);
});
