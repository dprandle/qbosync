import "../global_setup";
import mongo from "../db";
import { config } from "../config";
import { ensure_state_file_writable, get_sync_state, save_vendor_state } from "../sync_state";
import { create_qbo_object_map_item, type qbo_object_map } from "../qbo/object_map";
import { qbo_client } from "../qbo/client";
import { fetch_all_vendors, get_vendor_log_str, type qbo_vendor } from "./vendor_api";
import { is_active } from "../uobj_common";
import { type subc_doc, type hresource_doc, get_owner_hres_id, get_subc_log_str, resolve_subc } from "./subc";
import { load_owners } from "./sync";
import { ask_yes_no, ask_choice } from "../util";

// One-time bootstrap (npm run bootstrap_vendors): link the vendors already in QuickBooks to
// our subcontractors so the sync doesn't create duplicates of them. Run it after
// QuickBooks is connected and before the sync starts (the service idles until this
// sets bootstrap_complete). Re-running skips subcs/vendors that are already linked.
//
// Matching is by normalized name, against every name form a vendor might have been
// entered under (display/company/print-on-check name, given+family in either order).
// QBO masks TaxIdentifier on reads, but the visible last four digits are enough to
// rule a candidate out or to confirm it:
//   - exactly one candidate whose TIN last-4 matches ours  -> linked automatically
//   - one candidate matched by name only                   -> asks y/n
//   - several candidates                                   -> asks which one
//   - none                                                 -> left for the sync to
//                                                             create once complete
// Unlike qbtsync's bootstrap, unmatched vendors are only listed, never archived: most
// vendors in the books (suppliers, utilities) have nothing to do with subcs.
//
// New links get an empty synced_hash, so the first sync pass pushes our data
// (DisplayName, TIN, address, Vendor1099) onto every linked vendor.
//
// Flags: --dry-run  match and log only; write nothing and leave the flag unset.

const dry_run = process.argv.includes("--dry-run");

// Lowercase alphanumerics, minus trailing business suffixes, so "ABC Trucking, LLC"
// and "abc trucking" collide.
function norm_name(s: string | undefined): string {
    return (s ?? "")
        .toLowerCase()
        .replace(/\b(llc|l\.l\.c|inc|co|corp|corporation|company|ltd)\b\.?/g, "")
        .replace(/[^a-z0-9]/g, "");
}

function vendor_keys(v: qbo_vendor): string[] {
    const keys = [v.DisplayName, v.CompanyName, v.PrintOnCheckName];
    if (v.GivenName || v.FamilyName) {
        keys.push(`${v.GivenName ?? ""} ${v.FamilyName ?? ""}`, `${v.FamilyName ?? ""} ${v.GivenName ?? ""}`);
    }
    return [...new Set(keys.map(norm_name).filter(Boolean))];
}

function subc_keys(sc: subc_doc, owner: hresource_doc | null, resolved_name: string): string[] {
    const keys = [resolved_name, sc.name];
    if (owner) keys.push(`${owner.first_name} ${owner.last_name}`, `${owner.last_name} ${owner.first_name}`);
    return [...new Set(keys.map(norm_name).filter(Boolean))];
}

function last4(s: string | undefined): string {
    return (s ?? "").replace(/\D/g, "").slice(-4);
}

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
        const linked_subcs = new Set(existing.map((m) => m.our_id));
        const linked_vendors = new Set(existing.map((m) => m.qbo_id));

        const by_key = new Map<string, qbo_vendor[]>();
        for (const v of vendors) {
            for (const k of vendor_keys(v)) {
                const list = by_key.get(k) ?? [];
                list.push(v);
                by_key.set(k, list);
            }
        }

        // Active subcs first so they win a vendor two subcs both match.
        const ordered = [...subcs].sort(
            (a, b) => Number(!is_active(a.archived_info.on)) - Number(!is_active(b.archived_info.on))
        );

        const inserts: qbo_object_map[] = [];
        const no_match: subc_doc[] = [];
        for (const sc of ordered) {
            if (linked_subcs.has(sc._id)) continue;
            const owner_id = get_owner_hres_id(sc);
            const owner = owner_id ? (owners.get(owner_id) ?? null) : null;
            const r = resolve_subc(sc, owner);
            const label = `${get_subc_log_str(sc)} [${r.name}${r.active ? "" : ", archived"}]`;

            const seen = new Set<string>();
            let cands: qbo_vendor[] = [];
            for (const k of subc_keys(sc, owner, r.name)) {
                for (const v of by_key.get(k) ?? []) {
                    if (seen.has(v.Id) || linked_vendors.has(v.Id)) continue;
                    seen.add(v.Id);
                    cands.push(v);
                }
            }
            // A visible TIN that disagrees with ours rules the candidate out.
            const our4 = r.tin.length === 9 ? last4(r.tin) : "";
            if (our4) cands = cands.filter((v) => !v.TaxIdentifier || last4(v.TaxIdentifier) === our4);

            let pick: qbo_vendor | null = null;
            const tin_matched = cands.filter((v) => our4 && last4(v.TaxIdentifier) === our4);
            if (tin_matched.length === 1) {
                pick = tin_matched[0];
                ilog(`[bootstrap] ${label} -> ${get_vendor_log_str(pick)} (name + TIN last-4)`);
            } else if (cands.length === 1) {
                if (
                    await ask_yes_no(`[bootstrap] Link ${label} to ${get_vendor_log_str(cands[0])} (name match only)?`)
                ) {
                    pick = cands[0];
                }
            } else if (cands.length > 1) {
                const i = await ask_choice(
                    `[bootstrap] ${label} matches ${cands.length} vendors:`,
                    cands.map((v) => `${get_vendor_log_str(v)} TIN ***${last4(v.TaxIdentifier) || "----"}`)
                );
                if (i >= 0) pick = cands[i];
            }

            if (!pick) {
                if (r.active) no_match.push(sc);
                continue;
            }
            linked_subcs.add(sc._id);
            linked_vendors.add(pick.Id);
            inserts.push(
                create_qbo_object_map_item(pick.Id, sc._id, "vendor", new Date(pick.MetaData?.LastUpdatedTime ?? 0), "")
            );
        }

        for (const sc of no_match) {
            ilog(
                `[bootstrap] No vendor for active ${get_subc_log_str(sc)} - the sync will create one once it's complete`
            );
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
