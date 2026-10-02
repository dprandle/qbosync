import { qbo_client, q_str, type qbo_entity } from "../qbo/client";

export type qbo_addr = {
    Line1?: string;
    Line2?: string;
    City?: string;
    CountrySubDivisionCode?: string;
    PostalCode?: string;
};

// The subset of the QBO Vendor entity we read or write.
export type qbo_vendor = qbo_entity & {
    Active: boolean;
    DisplayName: string;
    CompanyName?: string;
    GivenName?: string;
    FamilyName?: string;
    PrintOnCheckName?: string;
    PrimaryEmailAddr?: { Address?: string };
    PrimaryPhone?: { FreeFormNumber?: string };
    BillAddr?: qbo_addr;
    // QBO masks this on reads (only the last 4 digits are visible), so it can only be
    // compared loosely - see bootstrap. We never diff against it.
    TaxIdentifier?: string;
    Vendor1099?: boolean;
};

// Fields we push. Id/SyncToken/sparse are added by update_vendor.
export type qbo_vendor_write = Omit<Partial<qbo_vendor>, "Id" | "SyncToken" | "MetaData">;

// A bare "select" only returns active vendors.
const ANY_ACTIVE = "Active in (true, false)";

// Returns null when the vendor doesn't exist (wrong realm, or mapping is stale).
export function get_vendor(qbo: qbo_client, id: string): Promise<qbo_vendor | null> {
    return qbo.read<qbo_vendor>("Vendor", id);
}

export function create_vendor(qbo: qbo_client, v: qbo_vendor_write): Promise<qbo_vendor> {
    return qbo.create<qbo_vendor>("Vendor", v);
}

// Sparse, so anything else on the vendor (terms, accounts, notes added by accounting)
// is left alone.
export function update_vendor(
    qbo: qbo_client,
    id: string,
    sync_token: string,
    v: qbo_vendor_write
): Promise<qbo_vendor> {
    return qbo.sparse_update<qbo_vendor>("Vendor", id, sync_token, v);
}

export function fetch_all_vendors(qbo: qbo_client): Promise<qbo_vendor[]> {
    return qbo.query_all<qbo_vendor>("Vendor", ANY_ACTIVE);
}

// Vendors whose ids are in `ids` (active and inactive), chunked to keep the query
// string reasonable. Used by cleanup to probe which mapped vendors still exist.
export async function fetch_vendors_by_ids(qbo: qbo_client, ids: string[]): Promise<qbo_vendor[]> {
    const out: qbo_vendor[] = [];
    for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        out.push(
            ...(await qbo.query<qbo_vendor>("Vendor", `${ANY_ACTIVE} and Id in (${chunk.map(q_str).join(", ")})`))
        );
    }
    return out;
}

export async function find_vendor_by_display_name(qbo: qbo_client, name: string): Promise<qbo_vendor | null> {
    const rows = await qbo.query<qbo_vendor>("Vendor", `${ANY_ACTIVE} and DisplayName = ${q_str(name)}`);
    return rows[0] ?? null;
}

export function get_vendor_log_str(v: qbo_vendor): string {
    return `vendor "${v.DisplayName}" (${v.Id}${v.Active ? "" : ", inactive"})`;
}
