import "../global_setup";
import { config } from "../config";
import { get_connection } from "../qbo/auth";
import { qbo_client, type qbo_entity } from "../qbo/client";
import { type qbo_vendor, type qbo_vendor_write, get_vendor, update_vendor } from "./vendor_api";
import { build_vendor_payload, type resolved_subc } from "./subc";
import { ask_yes_no, ask_choice, wait_for_enter } from "../util";

// Throwaway test (npm run test_vendor_updates), sandbox only. Answers two questions the
// Vendor docs don't settle:
//   1. Does QBO honor sparse: true on vendors, or does it wipe the fields we don't send?
//   2. Does QBO set the 1099 Contractor Type from the format of the tax ID?
// It creates its own test vendors with fake tax IDs and sets them inactive at the end. It
// tells you when to look at something in the QuickBooks dashboard. Delete it once it has
// answered these.

const FAKE_SSN = "123-45-6781";
const FAKE_EIN = "12-3456782";
const FAKE_EIN_DIGITS_AFTER_UPDATE = "123456783";

// Change on every write, or don't describe the vendor.
const IGNORED_FIELDS = new Set(["SyncToken", "MetaData", "domain", "sparse"]);

const CONTRACTOR_TYPES = ["Individual", "Business", "Not set or can't tell"];

type result = { name: string; status: "PASS" | "FAIL" | "INFO"; detail: string };
type field_diff = { field: string; kind: "lost" | "changed" | "added"; before: unknown; after: unknown };

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
    const i = await ask_choice("What does it show?", CONTRACTOR_TYPES);
    return i >= 0 ? CONTRACTOR_TYPES[i] : "Skipped";
}

async function create_test_vendors(stamp: string): Promise<{ ssn: qbo_vendor; ein: qbo_vendor }> {
    const base = {
        Vendor1099: true,
        BillAddr: { Line1: "1 Test St", City: "Dallas", CountrySubDivisionCode: "TX", PostalCode: "75001" },
    };
    // Every field here is one the sync doesn't own, so each is something a full update
    // would wipe.
    const terms = await qbo.query<qbo_entity>("Term", "", 1, 1);
    if (terms.length === 0) ilog("No terms in this sandbox - TermRef won't be part of the test.");
    const ssn = await qbo.create<qbo_vendor>("Vendor", {
        ...base,
        DisplayName: `qbosync test SSN ${stamp}`,
        TaxIdentifier: FAKE_SSN,
        AcctNum: "TEST-ACCT-1",
        Mobile: { FreeFormNumber: "(555) 555-0101" },
        Fax: { FreeFormNumber: "(555) 555-0102" },
        AlternatePhone: { FreeFormNumber: "(555) 555-0103" },
        WebAddr: { URI: "https://example.com" },
        PrimaryEmailAddr: { Address: "qbosync-test@example.com" },
        PrimaryPhone: { FreeFormNumber: "(555) 555-0104" },
        ...(terms[0] ? { TermRef: { value: terms[0].Id } } : {}),
    });
    const ein = await qbo.create<qbo_vendor>("Vendor", {
        ...base,
        DisplayName: `qbosync test EIN ${stamp}`,
        TaxIdentifier: FAKE_EIN,
    });
    return { ssn, ein };
}

async function test_contractor_type_on_create(ssn: qbo_vendor, ein: qbo_vendor): Promise<void> {
    heading("Contractor Type on new vendors");
    const from_ssn = await ask_contractor_type(ssn, FAKE_SSN);
    const from_ein = await ask_contractor_type(ein, FAKE_EIN);
    const follows = from_ssn === "Individual" && from_ein === "Business";
    const verdict = follows ? "It follows the format." : "It doesn't clearly follow the format.";
    record("Contractor Type on create", "INFO", `SSN format: ${from_ssn}, EIN format: ${from_ein}. ${verdict}`);
}

// Sends what a real linked vendor gets on its first push, changing the tax ID to an EIN the
// way a single member LLC's could change.
async function test_real_push(ssn_id: string, stamp: string): Promise<void> {
    heading("A real sync payload, changing the tax ID from SSN to EIN format");
    const resolved: resolved_subc = {
        display_name: `qbosync test pushed ${stamp}`,
        name: `qbosync test pushed ${stamp}`,
        given_name: "",
        family_name: "",
        name_from_owner: false,
        tin: FAKE_EIN_DIGITS_AFTER_UPDATE,
        tin_from_owner: false,
        email: "",
        phone: "",
        address: { street_addr1: "2 Test St", street_addr2: "", city: "Dallas", state: "TX", zip: "75001" },
        active: true,
    };
    const payload = build_vendor_payload(resolved);
    const expected = [...Object.keys(payload), "FullyQualifiedName"];
    const after = await run_update("Real sync payload", ssn_id, payload, expected);

    const visible = (after.TaxIdentifier ?? "").slice(-4);
    const stuck = visible === FAKE_EIN_DIGITS_AFTER_UPDATE.slice(-4);
    record(
        "Tax ID update",
        stuck ? "PASS" : "FAIL",
        `Tax ID update: vendor now shows ${after.TaxIdentifier ?? "nothing"}`
    );

    const type = await ask_contractor_type(after, payload.TaxIdentifier ?? "");
    record("Contractor Type on update", "INFO", `After changing SSN format to EIN format, it shows: ${type}.`);
}

// Optional, and the only step that needs a change made by hand: flip the setting in the
// dashboard and see whether anything in the API response moves.
async function test_hidden_field(ein_id: string): Promise<void> {
    heading("Optional: is Contractor Type hiding in the API response?");
    if (!(await ask_yes_no("Run this step? It needs one change in the dashboard"))) return;
    const before = await read_vendor(ein_id);
    ilog(`\nACTION: in the QuickBooks dashboard, open vendor "${before.DisplayName}" (ID ${ein_id}).`);
    ilog("        Switch its Contractor Type to the other option and save.");
    await wait_for_enter("Press Enter once it's saved");
    const after = await read_vendor(ein_id);
    if (after.SyncToken === before.SyncToken) {
        record("Hidden field", "INFO", "The vendor's SyncToken didn't change, so the save didn't register. No answer.");
        return;
    }
    const diffs = diff_vendors(before, after);
    print_diffs(diffs);
    if (diffs.length === 0)
        record("Hidden field", "INFO", "Nothing in the API response changed, so the API doesn't return it.");
    else record("Hidden field", "INFO", `Changed in the API response: ${diffs.map((d) => d.field).join(", ")}`);
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
            ? "\nAt least one update changed or was refused. Don't push to production until that's understood."
            : "\nSparse updates left everything else alone. The first push won't wipe the fields we don't send."
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
    heading("Creating test vendors");
    const { ssn, ein } = await create_test_vendors(stamp);
    ilog(`Created "${ssn.DisplayName}" (ID ${ssn.Id}) and "${ein.DisplayName}" (ID ${ein.Id})`);

    try {
        await run_step("Contractor Type on create", () => test_contractor_type_on_create(ssn, ein));

        heading("Sparse update of a single field");
        await run_step("Single field update", () =>
            run_update("Single field update", ssn.Id, { PrintOnCheckName: `Print ${stamp}` }, ["PrintOnCheckName"])
        );

        heading("Archive: sending only Active: false");
        await run_step("Archive update", () => run_update("Archive update", ssn.Id, { Active: false }, ["Active"]));

        heading("Reactivate: sending only Active: true");
        await run_step("Reactivate update", () =>
            run_update("Reactivate update", ssn.Id, { Active: true }, ["Active"])
        );

        await run_step("Real sync payload", () => test_real_push(ssn.Id, stamp));
        await run_step("Hidden field", () => test_hidden_field(ein.Id));
    } finally {
        await deactivate_test_vendors([ssn.Id, ein.Id]);
    }
    print_summary();
}

main()
    .catch((err) => {
        elog("[test] Fatal error:", err);
        process.exitCode = 1;
    })
    .finally(() => process.exit());
