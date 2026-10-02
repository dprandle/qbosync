import mongo from "../db";
import {
    get_sync_state,
    save_vendor_state,
    cursor_progress,
    safe_cursor,
    mark_unresolved,
    CURSOR_EPOCH,
} from "../sync_state";
import { create_qbo_object_map_item, type qbo_object_map } from "../qbo/object_map";
import { make_ci_now, INVALID_DATETIME } from "../uobj_common";
import { qbo_client, qbo_api_error } from "../qbo/client";
import {
    type qbo_vendor,
    get_vendor,
    create_vendor,
    update_vendor,
    find_vendor_by_display_name,
    get_vendor_log_str,
} from "./vendor_api";
import { get_connection, qbo_not_connected_error } from "../qbo/auth";
import { track_cursor_floor } from "../alerts";
import { record_vendor_failure, clear_vendor_failure } from "./failures";
import {
    type subc_doc,
    type hresource_doc,
    OWNER_PROJECTION,
    get_owner_hres_id,
    uses_owner,
    get_subc_log_str,
    resolve_subc,
    missing_required_fields,
    build_vendor_payload,
    vendor_hash,
    redact_payload,
} from "./subc";

// QBO "Duplicate Name Exists" - the DisplayName is already used by a vendor,
// customer or employee.
const QBO_DUPLICATE_NAME = "6240";

type candidate = {
    subc: subc_doc;
    subc_at?: Date; // set when the subc itself changed since the subc cursor
    hres_at?: Date; // set when its owner hresource changed since the hres cursor
    // Delta-triggered candidates retry a recorded permanent failure; the orphan sweep
    // only retries one whose pushed fields have changed since it failed.
    from_sweep: boolean;
};

export type subc_sync_ctx = {
    qbo: qbo_client;
    owners: Map<string, hresource_doc>;
    mappings: Map<string, qbo_object_map>;
};

export async function load_owners(subcs: subc_doc[]): Promise<Map<string, hresource_doc>> {
    const ids = [...new Set(subcs.map(get_owner_hres_id).filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const docs = await mongo
        .get_hresources()
        .find({ _id: { $in: ids } }, { projection: OWNER_PROJECTION })
        .toArray();
    return new Map(docs.map((h) => [h._id, h]));
}

export async function load_mappings(subc_ids: string[]): Promise<Map<string, qbo_object_map>> {
    const maps = await mongo
        .get_qbo_map_objects()
        .find({ type: "vendor", our_id: { $in: subc_ids } })
        .toArray();
    return new Map(maps.map((m) => [m.our_id, m]));
}

function last4(s: string | undefined): string {
    return (s ?? "").replace(/\D/g, "").slice(-4);
}

async function save_mapping_after_write(mapping: qbo_object_map, vendor: qbo_vendor, hash: string): Promise<void> {
    await mongo.get_qbo_map_objects().updateOne(
        { _id: mapping._id },
        {
            $set: {
                synced_hash: hash,
                qbo_modified: new Date(vendor.MetaData?.LastUpdatedTime ?? Date.now()),
                last_update: make_ci_now(),
            },
        }
    );
}

// A create rejected for a duplicate name is usually one of two benign cases: we
// created the vendor but crashed before inserting its mapping, or accounting entered
// the vendor by hand first. Link it only when that's unambiguous - an exact
// DisplayName match, not already linked to another subc, and a TIN whose visible last
// four digits match ours. Anything else stays a permanent failure for a human.
async function try_link_existing(
    qbo: qbo_client,
    sc: subc_doc,
    display_name: string,
    tin: string
): Promise<qbo_vendor | null> {
    const existing = await find_vendor_by_display_name(qbo, display_name);
    if (!existing) return null;
    const linked = await mongo.get_qbo_map_objects().findOne({ type: "vendor", qbo_id: existing.Id });
    if (linked) return null;
    if (!existing.TaxIdentifier || last4(existing.TaxIdentifier) !== last4(tin)) return null;
    ilog(`[vnd] Linking ${get_subc_log_str(sc)} to existing ${get_vendor_log_str(existing)} (name + TIN last-4 match)`);
    return existing;
}

// Reconciles one subc's vendor. Returns normally when the subc is resolved -
// including when it was skipped (incomplete) or permanently rejected (recorded +
// alerted). Throws only for transient failures, which the caller floors on.
export async function process_subc(sc: subc_doc, ctx: subc_sync_ctx, from_sweep: boolean): Promise<void> {
    const label = get_subc_log_str(sc);
    const owner_id = get_owner_hres_id(sc);
    const r = resolve_subc(sc, owner_id ? (ctx.owners.get(owner_id) ?? null) : null);
    const payload = build_vendor_payload(r);
    const hash = vendor_hash(payload);
    const missing = missing_required_fields(r);

    const failure = get_sync_state().vendors.failures[sc._id];
    if (from_sweep && failure && failure.hash === hash) return;

    let mapping = ctx.mappings.get(sc._id) ?? null;
    try {
        if (mapping) {
            if (mapping.synced_hash === hash) {
                clear_vendor_failure(sc._id);
                return;
            }
            // Don't blank out a linked vendor's TIN/address because the subc lost them;
            // hold the last good data until the subc is complete again. Archiving
            // still goes through - it only touches Active.
            if (r.active && missing.length > 0) {
                wlog(`[vnd] ${label} is linked but incomplete (missing ${missing.join(", ")}) - not updating vendor`);
                return;
            }
            const vendor = await get_vendor(ctx.qbo, mapping.qbo_id);
            if (!vendor) {
                // Stale mapping (vendor gone from this realm). Drop it and fall through
                // to the create path.
                wlog(`[vnd] Mapped vendor ${mapping.qbo_id} for ${label} not found in QBO - dropping mapping`);
                await mongo.get_qbo_map_objects().deleteOne({ _id: mapping._id });
                ctx.mappings.delete(sc._id);
                mapping = null;
            } else {
                if (!r.active && !vendor.Active) {
                    await save_mapping_after_write(mapping, vendor, hash);
                    ilog(`[vnd] ${label} archived; ${get_vendor_log_str(vendor)} already inactive`);
                    return;
                }
                const write = r.active ? payload : { Active: false };
                const updated = await update_vendor(ctx.qbo, vendor.Id, vendor.SyncToken, write);
                await save_mapping_after_write(mapping, updated, hash);
                clear_vendor_failure(sc._id);
                ilog(`[vnd] Updated ${get_vendor_log_str(updated)} for ${label} with:`, redact_payload(write));
                return;
            }
        }

        // No vendor yet. Archived subcs don't get one.
        if (!r.active) return;
        if (missing.length > 0) {
            if (!from_sweep) ilog(`[vnd] Skipping ${label} until complete - missing ${missing.join(", ")}`);
            return;
        }

        let vendor: qbo_vendor;
        try {
            vendor = await create_vendor(ctx.qbo, payload);
            ilog(`[vnd] Created ${get_vendor_log_str(vendor)} for ${label}:`, redact_payload(payload));
        } catch (err) {
            const existing =
                err instanceof qbo_api_error && err.codes.includes(QBO_DUPLICATE_NAME)
                    ? await try_link_existing(ctx.qbo, sc, payload.DisplayName!, r.tin)
                    : null;
            if (!existing) throw err;
            vendor = await update_vendor(ctx.qbo, existing.Id, existing.SyncToken, payload);
        }
        const map_obj = create_qbo_object_map_item(
            vendor.Id,
            sc._id,
            "vendor",
            new Date(vendor.MetaData?.LastUpdatedTime ?? Date.now()),
            hash
        );
        await mongo.get_qbo_map_objects().insertOne(map_obj);
        ctx.mappings.set(sc._id, map_obj);
        clear_vendor_failure(sc._id);
    } catch (err) {
        if (err instanceof qbo_api_error && err.permanent) {
            const msg = err.codes.includes(QBO_DUPLICATE_NAME)
                ? `The name "${payload.DisplayName}" is already used by another QuickBooks vendor, customer or employee (${err.message})`
                : err.message;
            elog(`[vnd] Permanent failure for ${label}: ${msg}`);
            await record_vendor_failure(sc._id, label, hash, msg);
            return;
        }
        throw err;
    }
}

function max_at(dates: Date[], fallback: Date): Date {
    return dates.reduce((m, d) => (d > m ? d : m), fallback);
}

export async function update_vendors_from_subcs(qbo: qbo_client): Promise<void> {
    // Not connected (or the refresh token died): leave the cursors where they are so
    // nothing is skipped, and try again next tick. qbo_auth has already alerted.
    try {
        await get_connection();
    } catch (err) {
        if (err instanceof qbo_not_connected_error) {
            wlog(`[vnd] ${err.message} - skipping pass`);
            return;
        }
        throw err;
    }

    const state = get_sync_state().vendors;
    const subc_since = state.subc_last_synced ?? CURSOR_EPOCH;
    const hres_since = state.hres_last_synced ?? CURSOR_EPOCH;
    ilog(`[vnd] Delta sync since subc ${subc_since.toISOString()} / hres ${hres_since.toISOString()}`);

    const subc_col = mongo.get_subcs();
    const changed_subcs = await subc_col.find({ "last_update.on": { $gt: subc_since } }).toArray();
    const changed_hres = await mongo
        .get_hresources()
        .find({ "last_update.on": { $gt: hres_since } }, { projection: { _id: 1, last_update: 1 } })
        .toArray();
    const hres_at = new Map(changed_hres.map((h) => [h._id, h.last_update.on]));

    const candidates = new Map<string, candidate>();
    for (const sc of changed_subcs) {
        candidates.set(sc._id, { subc: sc, subc_at: sc.last_update.on, from_sweep: false });
    }

    // Subcs whose owner changed and that pull at least one field from that owner.
    if (hres_at.size > 0) {
        const owned = await subc_col
            .find({ workers: { $elemMatch: { "hres_id.source_str": { $in: [...hres_at.keys()] } } } })
            .toArray();
        for (const sc of owned) {
            const owner_id = get_owner_hres_id(sc);
            const at = owner_id ? hres_at.get(owner_id) : undefined;
            if (!at || !uses_owner(sc)) continue;
            const cur = candidates.get(sc._id);
            if (cur) cur.hres_at = at;
            else candidates.set(sc._id, { subc: sc, hres_at: at, from_sweep: false });
        }
    }

    // Orphan sweep: active subcs with no vendor that the delta scan won't revisit
    // (a create that failed transiently after its cursor moved, a mapping dropped by
    // cleanup). Cheap - Mongo only - and QBO's unique DisplayName means a sweep can't
    // silently create a duplicate vendor; it would fail with a duplicate name instead.
    const active_subcs = await subc_col.find({ "archived_info.on": { $lte: INVALID_DATETIME } }).toArray();
    const mapped_ids = new Set(
        (
            await mongo
                .get_qbo_map_objects()
                .find(
                    { type: "vendor", our_id: { $in: active_subcs.map((s) => s._id) } },
                    { projection: { our_id: 1 } }
                )
                .toArray()
        ).map((m) => m.our_id)
    );
    for (const sc of active_subcs) {
        if (!mapped_ids.has(sc._id) && !candidates.has(sc._id)) {
            candidates.set(sc._id, { subc: sc, from_sweep: true });
        }
    }

    const list = [...candidates.values()];
    const ctx: subc_sync_ctx = {
        qbo,
        owners: await load_owners(list.map((c) => c.subc)),
        mappings: await load_mappings(list.map((c) => c.subc._id)),
    };

    // Every changed doc counts as resolved unless its processing throws, so both
    // cursors start at the newest changed timestamp and are floored by failures.
    const subc_progress: cursor_progress = {
        latest_resolved: max_at(
            changed_subcs.map((s) => s.last_update.on),
            subc_since
        ),
        earliest_unresolved: null,
    };
    const hres_progress: cursor_progress = {
        latest_resolved: max_at([...hres_at.values()], hres_since),
        earliest_unresolved: null,
    };

    for (let i = 0; i < list.length; ++i) {
        const c = list[i];
        const label = get_subc_log_str(c.subc);
        if (!c.from_sweep) ilog(`[vnd] Processing ${label} (${i + 1} of ${list.length})`);
        try {
            await process_subc(c.subc, ctx, c.from_sweep);
        } catch (err) {
            // Lost the connection mid-pass: the rest would all fail too. Bail without
            // saving either cursor so this whole changed set is re-scanned next time.
            if (err instanceof qbo_not_connected_error) {
                wlog(`[vnd] ${err.message} - aborting pass without advancing cursors`);
                return;
            }
            elog(`[vnd] Transient error syncing ${label}:`, err);
            const detail = `${label} (error: ${err})`;
            if (c.subc_at) mark_unresolved(subc_progress, c.subc_at, detail);
            if (c.hres_at) mark_unresolved(hres_progress, c.hres_at, detail);
        }
    }

    const next_subc = safe_cursor(subc_progress, subc_since);
    const next_hres = safe_cursor(hres_progress, hres_since);
    if (next_subc > subc_since || next_hres > hres_since) {
        save_vendor_state({ subc_last_synced: next_subc, hres_last_synced: next_hres });
        ilog(`[vnd] Cursors advanced to subc ${next_subc.toISOString()} / hres ${next_hres.toISOString()}`);
    } else {
        ilog("[vnd] No subcontractor/owner changes.");
    }
    await track_cursor_floor("subcontractors", subc_progress);
    await track_cursor_floor("hresources", hres_progress);
}
