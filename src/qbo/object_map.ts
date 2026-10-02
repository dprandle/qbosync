import { randomUUID } from "crypto";
import { type change_info, make_ci_now, make_ci_not_archived } from "../uobj_common";

// Only vendors today, but typed so other QBO entities (bills, payments) can share
// the collection later the same way qbtsync's map covers users/jobcodes/timesheets.
export type qbo_object_type = "vendor";

export type qbo_object_map = {
    _id: string;
    custom_params: Record<string, string>;
    archived_info: change_info;
    last_update: change_info;
    created: change_info;
    schema_version: number;
    qbo_id: string; // QBO entity Id (QBO ids are strings)
    our_id: string; // subcontractor _id
    type: qbo_object_type;
    // MetaData.LastUpdatedTime from QBO as of our last write. Informational/debugging.
    qbo_modified: Date;
    // Keyed HMAC of the vendor fields we last pushed (see vendor_hash). Empty means
    // "never pushed" (fresh bootstrap link), which forces a full update on first sync.
    synced_hash: string;
};

export function create_qbo_object_map_item(
    qbo_id: string,
    our_id: string,
    type: qbo_object_type,
    qbo_modified: Date,
    synced_hash: string
): qbo_object_map {
    const now_ci = make_ci_now();
    return {
        _id: randomUUID(),
        custom_params: {},
        archived_info: make_ci_not_archived(),
        last_update: now_ci,
        created: now_ci,
        schema_version: 1,
        qbo_id,
        our_id,
        type,
        qbo_modified,
        synced_hash,
    };
}
