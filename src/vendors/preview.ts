import "../global_setup";
import mongo from "../db";
import { get_sync_state } from "../sync_state";
import { qbo_client } from "../qbo/client";
import { type qbo_vendor, type qbo_vendor_write, fetch_all_vendors } from "./vendor_api";
import {
    type subc_doc,
    type hresource_doc,
    get_owner_hres_id,
    resolve_subc,
    missing_required_fields,
    build_vendor_payload,
    redact_payload,
    get_contractor_type,
    is_valid_email,
} from "./subc";
import { load_owners, load_mappings } from "./sync";
import { match_vendor, is_plausible } from "./vendor_match";

// Read-only (npm run preview_vendors): shows what the sync would push for every subc - the
// resolved vendor fields (TIN redacted), what's missing, whether it's linked, and any
// DisplayName that would collide. Reads QuickBooks to look for those collisions but never
// writes to it or the database. If QuickBooks can't be read, it says so and still checks
// the subcs against each other. Pass --json for machine-readable output.

const as_json = process.argv.includes("--json");

type preview_status = "failed" | "incomplete" | "ready" | "linked" | "archived_linked" | "archived";

type preview_row = {
    id: string;
    name: string;
    status: preview_status;
    active: boolean;
    owner: string | null;
    linked_vendor: string | null;
    failure: string | null;
    missing: string[];
    warnings: string[];
    collisions: string[];
    tin_source: "SSN" | "EIN";
    contractor_type: "Individual" | "Business";
    vendor: qbo_vendor_write | null;
};

// Something in QuickBooks already using a DisplayName, which must be unique across vendors,
// customers and employees.
type name_holder = {
    name: string;
    label: string;
    vendor: qbo_vendor | null;
};

type named_entity = { Id: string; DisplayName?: string; Active?: boolean };

function get_status(active: boolean, linked: boolean, failed: boolean, incomplete: boolean): preview_status {
    if (!active) return linked ? "archived_linked" : "archived";
    if (failed) return "failed";
    if (incomplete) return "incomplete";
    return linked ? "linked" : "ready";
}

function holder_label(kind: string, e: named_entity): string {
    return `${kind} "${e.DisplayName}" (ID ${e.Id}${e.Active === false ? ", inactive" : ""})`;
}

// Returns what it could read, plus a note for anything it couldn't, since a missing list
// means collisions with those entities went unchecked.
async function load_name_holders(qbo: qbo_client): Promise<{ holders: name_holder[]; problems: string[] }> {
    const holders: name_holder[] = [];
    const problems: string[] = [];
    const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));
    try {
        for (const v of await fetch_all_vendors(qbo)) {
            holders.push({ name: v.DisplayName, label: holder_label("vendor", v), vendor: v });
        }
    } catch (err) {
        problems.push(`Couldn't read vendors: ${describe(err)}`);
    }
    for (const [entity, kind] of [
        ["Customer", "customer"],
        ["Employee", "employee"],
    ]) {
        try {
            for (const e of await qbo.query_all<named_entity>(entity, "Active in (true, false)")) {
                if (e.DisplayName) holders.push({ name: e.DisplayName, label: holder_label(kind, e), vendor: null });
            }
        } catch (err) {
            problems.push(`Couldn't read ${kind}s: ${describe(err)}`);
        }
    }
    return { holders, problems };
}

function name_key(s: string): string {
    return s.trim().replace(/\s+/g, " ").toLowerCase();
}

// Fills in row.collisions for every subc whose name the sync will push. Two subcs resolving
// to one name is a data error (an owner with several entities needs their company names on
// file), so the sync lets the later one fail and alert. This shows them ahead of time.
function find_collisions(
    rows: preview_row[],
    holders: name_holder[],
    sources: Map<string, { sc: subc_doc; owner: hresource_doc | null }>,
    bootstrap_complete: boolean
): void {
    const pushing = rows.filter((r) => r.active && r.vendor);

    const rows_by_name = new Map<string, preview_row[]>();
    for (const row of pushing) {
        const list = rows_by_name.get(name_key(row.name)) ?? [];
        list.push(row);
        rows_by_name.set(name_key(row.name), list);
    }
    const holders_by_name = new Map<string, name_holder[]>();
    for (const holder of holders) {
        const list = holders_by_name.get(name_key(holder.name)) ?? [];
        list.push(holder);
        holders_by_name.set(name_key(holder.name), list);
    }

    for (const row of pushing) {
        const key = name_key(row.name);
        const others = (rows_by_name.get(key) ?? []).filter((o) => o !== row);
        for (const o of others) row.collisions.push(`Same name as subcontractor ${o.id}`);

        for (const holder of holders_by_name.get(key) ?? []) {
            const vendor = holder.vendor;
            if (vendor) {
                if (vendor.Id === row.linked_vendor) continue;
                // Already reported above, as a collision with the subc that owns this vendor.
                if (others.some((o) => o.linked_vendor === vendor.Id)) continue;
                // Before the bootstrap, this is probably the vendor it will link to.
                const source = sources.get(row.id);
                const match = source ? match_vendor(source.sc, source.owner, vendor) : null;
                if (!bootstrap_complete && !row.linked_vendor && match && is_plausible(match)) continue;
            }
            row.collisions.push(`Name already used by ${holder.label}`);
        }
    }
}

function field(label: string, value: string): string {
    return `    ${label.padEnd(18)}${value}`;
}

function format_address(v: qbo_vendor_write): string {
    const a = v.BillAddr;
    if (!a) return "-";
    const state_zip = [a.CountrySubDivisionCode, a.PostalCode].filter(Boolean).join(" ");
    return [a.Line1, a.Line2, a.City, state_zip].filter(Boolean).join(", ");
}

function format_row(row: preview_row): string[] {
    const lines = [`  ${row.name}`, field("Subcontractor", row.id)];
    if (row.owner) lines.push(field("Owner", row.owner));
    if (row.linked_vendor) lines.push(field("Linked vendor", row.linked_vendor));
    if (row.failure) lines.push(field("Last failure", row.failure));
    if (row.missing.length > 0) lines.push(field("Missing", row.missing.join(", ")));

    const v = row.vendor;
    if (v) {
        const person_name = `${v.GivenName ?? ""} ${v.FamilyName ?? ""}`.trim();
        lines.push(
            field("Person name", person_name || "-"),
            field("Company name", v.CompanyName || "-"),
            field("Print on check", v.PrintOnCheckName ?? "-"),
            field("Tax ID", `${row.tin_source} ${v.TaxIdentifier ?? "-"}`),
            field("Contractor type", row.contractor_type),
            field("Address", format_address(v)),
            field("Email", v.PrimaryEmailAddr?.Address ?? "-"),
            field("Phone", v.PrimaryPhone?.FreeFormNumber ?? "-")
        );
    }
    for (const w of row.warnings) lines.push(field("Warning", w));
    return lines;
}

function print_section(
    title: string,
    rows: preview_row[],
    format: (row: preview_row) => string[],
    spaced = true
): void {
    if (rows.length === 0) return;
    console.log(`\n${title} (${rows.length})`);
    console.log("-".repeat(title.length + rows.length.toString().length + 3));
    rows.forEach((row, i) => {
        if (i > 0 && spaced) console.log("");
        format(row).forEach((line) => console.log(line));
    });
}

function format_compact(row: preview_row): string[] {
    const vendor = row.linked_vendor ? ` -> vendor ${row.linked_vendor}` : "";
    return [`  ${row.name} (${row.id})${vendor}`];
}

function format_collision(row: preview_row): string[] {
    return [`  ${row.name} (${row.id})`, ...row.collisions.map((c) => `    ${c}`)];
}

function print_preview(rows: preview_row[], problems: string[]): void {
    const of = (status: preview_status) => rows.filter((r) => r.status === status);
    const colliding = rows.filter((r) => r.collisions.length > 0);

    if (problems.length > 0) {
        console.log("\nCollision check is incomplete");
        console.log("-----------------------------");
        for (const p of problems) console.log(`  ${p}`);
    }
    print_section("Name collisions - the sync will fail and alert", colliding, format_collision);
    print_section("Last sync failed", of("failed"), format_row);
    print_section("Incomplete - no updates until fixed", of("incomplete"), format_row);
    print_section("Ready - vendor will be created", of("ready"), format_row);
    print_section("Linked - vendor will be kept in sync", of("linked"), format_row);
    print_section("Archived - vendor kept inactive", of("archived_linked"), format_compact, false);
    print_section("Archived - no vendor, none will be created", of("archived"), format_compact, false);

    const active = rows.filter((r) => r.active).length;
    console.log("\nSummary");
    console.log("-------");
    const counts: [string, number][] = [
        ["Subcontractors", rows.length],
        ["Active", active],
        ["Name collisions", colliding.length],
        ["Failed", of("failed").length],
        ["Incomplete", of("incomplete").length],
        ["Ready to create", of("ready").length],
        ["Linked", of("linked").length],
    ];
    for (const [label, n] of counts) console.log(`  ${label.padEnd(18)}${n}`);
}

async function main(): Promise<void> {
    await mongo.connect();
    try {
        const subcs = await mongo.get_subcs().find({}).sort({ name: 1 }).toArray();
        const owners = await load_owners(subcs);
        const mappings = await load_mappings(subcs.map((s) => s._id));
        const state = get_sync_state().vendors;
        const sources = new Map<string, { sc: subc_doc; owner: hresource_doc | null }>();

        const rows = subcs.map((sc): preview_row => {
            const owner_id = get_owner_hres_id(sc);
            const owner = owner_id ? (owners.get(owner_id) ?? null) : null;
            sources.set(sc._id, { sc, owner });
            const r = resolve_subc(sc, owner);
            const missing = missing_required_fields(r);
            const m = mappings.get(sc._id);
            const failure = state.failures[sc._id]?.error ?? null;
            const warnings: string[] = [];
            if (r.email && !is_valid_email(r.email)) warnings.push(`Email "${r.email}" isn't valid, so it's left out`);
            return {
                id: sc._id,
                name: build_vendor_payload(r).DisplayName || "(no name)",
                status: get_status(r.active, Boolean(m), Boolean(failure), missing.length > 0),
                active: r.active,
                owner: owner_id ? (owners.has(owner_id) ? owner_id : `${owner_id} (not found)`) : null,
                linked_vendor: m?.qbo_id ?? null,
                failure,
                missing,
                warnings,
                collisions: [],
                tin_source: r.tin_from_owner ? "SSN" : "EIN",
                contractor_type: get_contractor_type(r),
                vendor: missing.length === 0 ? redact_payload(build_vendor_payload(r)) : null,
            };
        });

        const { holders, problems } = await load_name_holders(new qbo_client());
        find_collisions(rows, holders, sources, state.bootstrap_complete);

        if (as_json) console.log(JSON.stringify({ collision_check_problems: problems, rows }, null, 2));
        else print_preview(rows, problems);
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("[preview] Fatal error:", err);
    process.exit(1);
});
