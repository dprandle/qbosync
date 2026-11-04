import "../global_setup";
import { config } from "../config";
import { get_connection } from "../qbo/auth";
import { qbo_client, type qbo_entity } from "../qbo/client";
import { make_ci_now, make_ci_not_archived } from "../uobj_common";
import { type qbo_vendor, type qbo_vendor_write, get_vendor, update_vendor } from "./vendor_api";
import {
    type hresource_doc,
    type subc_doc,
    SC_ENTITY_FLAG_USE_OWNER_NAME,
    SC_ENTITY_TYPE_SOLE_PROPRIETER,
    build_vendor_payload,
    resolve_subc,
} from "./subc";
import { last4 } from "./vendor_match";
import { ask_yes_no, ask_choice } from "../util";

// Throwaway test (npm run test_vendor_updates), sandbox only. Answers what the Vendor docs
// don't settle about updating an existing vendor:
//   1. Does QBO honor sparse: true on vendors, or does it wipe the fields we don't send?
//   2. Do empty strings actually clear GivenName, FamilyName and CompanyName?
//   3. Does QBO recalculate Contractor Type when those fields change?
// Payloads come from the sync's own resolve_subc and build_vendor_payload, so this tests
// what the first push really sends.
//
// Pass --contractor-matrix (npm run test_vendor_updates -- --contractor-matrix) to skip the
// update tests and try every combination of name fields and tax ID format on new vendors.
//
// It creates its own test vendors with fake tax IDs and sets them inactive at the end. It
// tells you when to look at something in the QuickBooks dashboard. Delete it once it has
// answered these.

const FAKE_SSN = "123-45-6781";
const FAKE_EIN = "12-3456782";

// Mirrors SC_ENTITY_TYPE_LLC in uber, labelled Multi Member LLC/Corp.
const SC_ENTITY_TYPE_MULTI_MEMBER = 1;

// Change on every write, or don't describe the vendor.
const IGNORED_FIELDS = new Set(["SyncToken", "MetaData", "domain", "sparse"]);

// The name fields a payload sets, each of which should read back with the value we sent.
// An empty string should read back as empty or missing.
const CHECKED_NAME_FIELDS = ["DisplayName", "PrintOnCheckName", "GivenName", "FamilyName", "CompanyName"] as const;

const CONTRACTOR_TYPES = ["Individual", "Business", "Not set or can't tell"];

type result = { name: string; status: "PASS" | "FAIL" | "INFO"; detail: string };
type field_diff = { field: string; kind: "lost" | "changed" | "added"; before: unknown; after: unknown };
type matrix_row = {
    person: boolean;
    company: boolean;
    tin_kind: "SSN" | "EIN";
    tin: string;
    name: string;
    vendor: qbo_vendor | null;
    result: string;
};

const qbo = new qbo_client();
const results: result[] = [];

function record(name: string, status: result["status"], detail: string): void {
    results.push({ name, status, detail });
    ilog(`\n  ${status}  ${detail}`);
}

function heading(title: string): void {
    ilog(`\n=== ${title} ===`);
}

async function read_vendor(id: string): Promise<qbo_vendor> {
    const v = await get_vendor(qbo, id);
    if (!v) throw new Error(`Vendor ${id} not found`);
    return v;
}

function diff_vendors(before: qbo_vendor, after: qbo_vendor): field_diff[] {
    const [b, a] = [before as Record<string, unknown>, after as Record<string, unknown>];
    const diffs: field_diff[] = [];
    for (const field of new Set([...Object.keys(b), ...Object.keys(a)])) {
        if (IGNORED_FIELDS.has(field) || JSON.stringify(b[field]) === JSON.stringify(a[field])) continue;
        const kind = !(field in a) ? "lost" : !(field in b) ? "added" : "changed";
        diffs.push({ field, kind, before: b[field], after: a[field] });
    }
    return diffs;
}

function print_diffs(diffs: field_diff[]): void {
    for (const d of diffs) {
        ilog(`    ${d.field}: ${d.kind}  ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
    }
}

// QBO may add " (deleted)" to an inactive entity's names and remove it on reactivation.
// That's not data loss.
function is_deleted_rename(d: field_diff): boolean {
    const strip = (s: unknown) => String(s).replace(/\s*\(deleted\)$/, "");
    return d.kind === "changed" && strip(d.before) === strip(d.after);
}

// Sends `write` as our sync does and reports anything that changed besides `expected`.
async function run_update(name: string, id: string, write: qbo_vendor_write, expected: string[]): Promise<qbo_vendor> {
    const before = await read_vendor(id);
    await update_vendor(qbo, id, before.SyncToken, write);
    const after = await read_vendor(id);
    const allowed = new Set(expected);
    const unexpected = diff_vendors(before, after).filter((d) => !allowed.has(d.field) && !is_deleted_rename(d));
    print_diffs(unexpected);
    if (unexpected.length === 0) record(name, "PASS", `${name}: no other fields changed`);
    else record(name, "FAIL", `${name}: also changed ${unexpected.map((d) => `${d.field} (${d.kind})`).join(", ")}`);
    return after;
}

async function ask_contractor_type(vendor: qbo_vendor, tin: string): Promise<string> {
    ilog(`\nACTION: in the QuickBooks dashboard, open vendor "${vendor.DisplayName}" (ID ${vendor.Id}).`);
    ilog(`        Its tax ID was sent as ${tin}. Look at Contractor Type under its personal details.`);
    ilog("        Also note whether its personal info shows as missing.");
    const i = await ask_choice("What does Contractor Type show?", CONTRACTOR_TYPES);
    return i >= 0 ? CONTRACTOR_TYPES[i] : "Skipped";
}

// Starts as matrix row 1 (person name, company name, SSN). Every field the sync doesn't own
// is something a full update would wipe.
async function create_test_vendor(stamp: string): Promise<qbo_vendor> {
    const terms = await qbo.query<qbo_entity>("Term", "", 1, 1);
    if (terms.length === 0) ilog("No terms in this sandbox - TermRef won't be part of the test.");
    return qbo.create<qbo_vendor>("Vendor", {
        DisplayName: `qbosync test ${stamp}`,
        Vendor1099: true,
        GivenName: "Test",
        FamilyName: "Vendor",
        CompanyName: `qbosync test company ${stamp}`,
        TaxIdentifier: FAKE_SSN,
        BillAddr: { Line1: "1 Test St", City: "Dallas", CountrySubDivisionCode: "TX", PostalCode: "75001" },
        AcctNum: "TEST-ACCT-1",
        Mobile: { FreeFormNumber: "(555) 555-0101" },
        Fax: { FreeFormNumber: "(555) 555-0102" },
        AlternatePhone: { FreeFormNumber: "(555) 555-0103" },
        WebAddr: { URI: "https://example.com" },
        PrimaryEmailAddr: { Address: "qbosync-test@example.com" },
        PrimaryPhone: { FreeFormNumber: "(555) 555-0104" },
        ...(terms[0] ? { TermRef: { value: terms[0].Id } } : {}),
    });
}

// What the sync would send for a subc of this classification with USE_OWNER_NAME set. Email
// and phone are blank, so the payload leaves them out and they should survive.
function build_real_payload(stamp: string, entity_type: number): qbo_vendor_write {
    const addr = { street_addr1: "2 Test St", street_addr2: "", city: "Dallas", state: "TX", zip: "75001" };
    const sc: subc_doc = {
        _id: "test-subc",
        name: `Test Company ${stamp}`,
        ein: FAKE_EIN,
        email: "",
        phone_number: "",
        notes: "",
        phys_address: addr,
        mail_address: addr,
        flags: SC_ENTITY_FLAG_USE_OWNER_NAME,
        entity_type,
        archived_info: make_ci_not_archived(),
        last_update: make_ci_now(),
    };
    const owner: hresource_doc = {
        _id: "test-owner",
        first_name: "Test",
        last_name: `Owner ${stamp}`,
        email: "",
        phone_number: "",
        detail: { SSN: FAKE_SSN },
        archived_info: make_ci_not_archived(),
        last_update: make_ci_now(),
    };
    return build_vendor_payload(resolve_subc(sc, owner));
}

// Accepting a value isn't the same as storing it, so read the fields back. This is what
// would catch QBO ignoring an empty GivenName and leaving a vendor Individual.
function check_fields_stuck(name: string, after: qbo_vendor, payload: qbo_vendor_write): void {
    const wrong: string[] = [];
    for (const field of CHECKED_NAME_FIELDS) {
        const [sent, got] = [payload[field] ?? "", after[field] ?? ""];
        if (sent !== got) wrong.push(`${field} sent "${sent}", reads "${got}"`);
    }
    if (last4(after.TaxIdentifier) !== last4(payload.TaxIdentifier)) {
        wrong.push(`TaxIdentifier sent ***${last4(payload.TaxIdentifier)}, reads ${after.TaxIdentifier ?? "nothing"}`);
    }
    if (wrong.length === 0) record(name, "PASS", `${name}: names and tax ID read back as sent`);
    else record(name, "FAIL", `${name}: ${wrong.join("; ")}`);
}

// Pushes one classification's payload to the vendor and returns the Contractor Type it ends
// up with, or null if the push itself failed.
async function test_push(label: string, id: string, payload: qbo_vendor_write, want: string): Promise<string | null> {
    heading(`${label} payload: ${payload.DisplayName}`);
    const expected = [...Object.keys(payload), "FullyQualifiedName"];
    let after: qbo_vendor;
    try {
        after = await run_update(`${label} payload`, id, payload, expected);
    } catch (err) {
        record(`${label} payload`, "FAIL", `${label} payload: ${err instanceof Error ? err.message : err}`);
        return null;
    }
    check_fields_stuck(`${label} fields`, after, payload);
    const type = await ask_contractor_type(after, payload.TaxIdentifier ?? "");
    const verdict = type === want ? "as it should" : `should be ${want}`;
    record(`${label} Contractor Type`, "INFO", `${label} Contractor Type on update: ${type}, ${verdict}.`);
    return type;
}

// Every combination of person name, company name and tax ID format, to work out exactly
// what sets Contractor Type. "Unset" means sent as an empty string, not left out, since a
// missing field makes the dashboard look like personal information is missing. Run on its
// own with --contractor-matrix.
async function run_contractor_matrix(stamp: string): Promise<void> {
    heading("Creating one vendor per combination");
    const rows: matrix_row[] = [];
    for (const person of [true, false]) {
        for (const company of [true, false]) {
            for (const tin_kind of ["SSN", "EIN"] as const) {
                const n = 10 + rows.length;
                const tin = tin_kind === "SSN" ? `123-45-67${n}` : `12-34567${n}`;
                const parts = [person ? "person" : "no person", company ? "company" : "no company", tin_kind];
                const name = `qbosync matrix ${stamp} ${rows.length + 1} ${parts.join(", ")}`;
                const row: matrix_row = { person, company, tin_kind, tin, name, vendor: null, result: "" };
                try {
                    row.vendor = await qbo.create<qbo_vendor>("Vendor", {
                        DisplayName: name,
                        Vendor1099: true,
                        TaxIdentifier: tin,
                        BillAddr: {
                            Line1: "1 Test St",
                            City: "Dallas",
                            CountrySubDivisionCode: "TX",
                            PostalCode: "75001",
                        },
                        GivenName: person ? "Test" : "",
                        FamilyName: person ? "Vendor" : "",
                        CompanyName: company ? `qbosync test company ${stamp} ${rows.length + 1}` : "",
                    });
                    ilog(`  ID ${row.vendor.Id.padEnd(8)}${name}`);
                } catch (err) {
                    row.result = `Refused: ${err instanceof Error ? err.message : err}`;
                    ilog(`  Refused ${name}: ${row.result}`);
                }
                rows.push(row);
            }
        }
    }

    try {
        heading("Checking each vendor in the dashboard");
        for (const row of rows) {
            if (row.vendor) row.result = await ask_contractor_type(row.vendor, row.tin);
        }
    } finally {
        await deactivate_test_vendors(rows.flatMap((r) => (r.vendor ? [r.vendor.Id] : [])));
    }

    heading("Contractor Type by combination");
    ilog(`  ${"Person name".padEnd(14)}${"Company name".padEnd(15)}${"Tax ID".padEnd(9)}Contractor Type`);
    for (const r of rows) {
        const [person, company] = [r.person ? "set" : "unset", r.company ? "set" : "unset"];
        ilog(`  ${person.padEnd(14)}${company.padEnd(15)}${r.tin_kind.padEnd(9)}${r.result}`);
    }
}

// A failing step is itself an answer (a rejected Active-only update would suggest QBO
// wants the full object), so it's recorded and the rest still runs.
async function run_step(name: string, step: () => Promise<unknown>): Promise<void> {
    try {
        await step();
    } catch (err) {
        record(name, "FAIL", `${name}: ${err instanceof Error ? err.message : err}`);
    }
}

async function deactivate_test_vendors(ids: string[]): Promise<void> {
    heading("Cleaning up");
    for (const id of ids) {
        try {
            const v = await read_vendor(id);
            if (v.Active) await update_vendor(qbo, id, v.SyncToken, { Active: false });
            ilog(`Vendor ${id} is inactive`);
        } catch (err) {
            wlog(`Couldn't deactivate vendor ${id}, so do it by hand: ${err}`);
        }
    }
}

function print_summary(): void {
    heading("Summary");
    for (const r of results) ilog(`  ${r.status.padEnd(5)}${r.detail}`);
    const failed = results.some((r) => r.status === "FAIL");
    ilog(
        failed
            ? "\nAt least one update changed something else, didn't stick or was refused. Don't push to production until that's understood."
            : "\nUpdates left everything else alone and every field read back as sent. Check the Contractor Type lines above."
    );
    if (failed) process.exitCode = 1;
}

async function main(): Promise<void> {
    if (config.qbo_env !== "sandbox") {
        throw new Error(`Refusing to run with QBO_ENV=${config.qbo_env}. This test only runs against a sandbox.`);
    }
    const { realm_id } = await get_connection();
    const company = await qbo.read<qbo_entity & { CompanyName?: string }>("CompanyInfo", realm_id);
    ilog(
        `Sandbox company: ${company?.CompanyName ?? "(unknown)"}, realm ${realm_id}, minor version ${config.qbo_minor_version}`
    );
    if (!(await ask_yes_no("Create test vendors in this sandbox company?"))) return;

    const stamp = Date.now().toString(36);
    if (process.argv.includes("--contractor-matrix")) {
        await run_contractor_matrix(stamp);
        return;
    }

    heading("Creating a test vendor");
    const vendor = await create_test_vendor(stamp);
    ilog(`Created "${vendor.DisplayName}" (ID ${vendor.Id})`);

    try {
        heading("Sparse update of a single field");
        await run_step("Single field update", () =>
            run_update("Single field update", vendor.Id, { PrintOnCheckName: `Print ${stamp}` }, ["PrintOnCheckName"])
        );

        heading("Archive: sending only Active: false");
        await run_step("Archive update", () => run_update("Archive update", vendor.Id, { Active: false }, ["Active"]));

        heading("Reactivate: sending only Active: true");
        await run_step("Reactivate update", () =>
            run_update("Reactivate update", vendor.Id, { Active: true }, ["Active"])
        );

        const business = build_real_payload(stamp, SC_ENTITY_TYPE_MULTI_MEMBER);
        const to_business = await test_push("Multi Member/Corp", vendor.Id, business, "Business");

        const individual = build_real_payload(stamp, SC_ENTITY_TYPE_SOLE_PROPRIETER);
        const to_individual = await test_push("Sole Prop", vendor.Id, individual, "Individual");

        if (to_business === "Business" && to_individual === "Individual") {
            record("Recalculates", "INFO", "Contractor Type recalculated on update in both directions.");
        } else {
            record("Recalculates", "INFO", "Contractor Type did not follow the update in both directions.");
        }
    } finally {
        await deactivate_test_vendors([vendor.Id]);
    }
    print_summary();
}

main()
    .catch((err) => {
        elog("[test] Fatal error:", err);
        process.exitCode = 1;
    })
    .finally(() => process.exit());
