import "../global_setup";
import mongo from "../db";
import { get_sync_state } from "../sync_state";
import { type qbo_vendor_write } from "./vendor_api";
import {
    get_owner_hres_id,
    resolve_subc,
    missing_required_fields,
    build_vendor_payload,
    redact_payload,
    get_contractor_type,
    is_valid_email,
} from "./subc";
import { load_owners, load_mappings } from "./sync";

// Read-only (npm run preview_vendors): shows what the sync would push for every subc - the
// resolved vendor fields (TIN redacted), what's missing, and whether it's linked - plus the
// Contractor Type each vendor needs set by hand in QuickBooks. No QBO calls and no writes,
// so it's safe against any database. Pass --json for machine-readable output.

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
    tin_source: "SSN" | "EIN";
    contractor_type: "Individual" | "Business";
    vendor: qbo_vendor_write | null;
};

function get_status(active: boolean, linked: boolean, failed: boolean, incomplete: boolean): preview_status {
    if (!active) return linked ? "archived_linked" : "archived";
    if (failed) return "failed";
    if (incomplete) return "incomplete";
    return linked ? "linked" : "ready";
}

// A vendor exists or is about to, so it needs its Contractor Type set.
function needs_contractor_type(row: preview_row): boolean {
    return row.active && (row.linked_vendor !== null || row.missing.length === 0);
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
            field("Address", format_address(v)),
            field("Email", v.PrimaryEmailAddr?.Address ?? "-"),
            field("Phone", v.PrimaryPhone?.FreeFormNumber ?? "-")
        );
    }
    for (const w of row.warnings) lines.push(field("Warning", w));
    return lines;
}

function print_section(title: string, rows: preview_row[], format: (row: preview_row) => string[]): void {
    if (rows.length === 0) return;
    console.log(`\n${title} (${rows.length})`);
    console.log("-".repeat(title.length + rows.length.toString().length + 3));
    rows.forEach((row, i) => {
        if (i > 0 && format === format_row) console.log("");
        format(row).forEach((line) => console.log(line));
    });
}

function format_compact(row: preview_row): string[] {
    const vendor = row.linked_vendor ? ` -> vendor ${row.linked_vendor}` : "";
    return [`  ${row.name} (${row.id})${vendor}`];
}

function print_worklist(rows: preview_row[]): void {
    const list = rows.filter(needs_contractor_type).sort((a, b) => {
        return a.contractor_type.localeCompare(b.contractor_type) || a.name.localeCompare(b.name);
    });
    if (list.length === 0) return;

    const title = `Contractor Type to set in QuickBooks (${list.length})`;
    console.log(`\n${title}`);
    console.log("-".repeat(title.length));
    console.log("  The API doesn't expose this setting. Set by hand, under each vendor's personal details.\n");

    const name_width = Math.max("Vendor".length, ...list.map((r) => r.name.length));
    console.log(`  ${"Type".padEnd(12)}${"Vendor".padEnd(name_width + 2)}Vendor ID`);
    for (const row of list) {
        console.log(
            `  ${row.contractor_type.padEnd(12)}${row.name.padEnd(name_width + 2)}${row.linked_vendor ?? "(new)"}`
        );
    }
}

function print_preview(rows: preview_row[]): void {
    const of = (status: preview_status) => rows.filter((r) => r.status === status);

    print_section("Last sync failed", of("failed"), format_row);
    print_section("Incomplete - no updates until fixed", of("incomplete"), format_row);
    print_section("Ready - vendor will be created", of("ready"), format_row);
    print_section("Linked - vendor will be kept in sync", of("linked"), format_row);
    print_section("Archived - vendor kept inactive", of("archived_linked"), format_compact);
    print_section("Archived - no vendor, none will be created", of("archived"), format_compact);
    print_worklist(rows);

    const active = rows.filter((r) => r.active).length;
    console.log("\nSummary");
    console.log("-------");
    const counts: [string, number][] = [
        ["Subcontractors", rows.length],
        ["Active", active],
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
        const failures = get_sync_state().vendors.failures;

        const rows = subcs.map((sc): preview_row => {
            const owner_id = get_owner_hres_id(sc);
            const r = resolve_subc(sc, owner_id ? (owners.get(owner_id) ?? null) : null);
            const missing = missing_required_fields(r);
            const m = mappings.get(sc._id);
            const failure = failures[sc._id]?.error ?? null;
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
                tin_source: r.tin_from_owner ? "SSN" : "EIN",
                contractor_type: get_contractor_type(r),
                vendor: missing.length === 0 ? redact_payload(build_vendor_payload(r)) : null,
            };
        });

        if (as_json) console.log(JSON.stringify(rows, null, 2));
        else print_preview(rows);
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("[preview] Fatal error:", err);
    process.exit(1);
});
