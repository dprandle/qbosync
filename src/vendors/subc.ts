import { createHmac } from "crypto";
import { config } from "../config";
import { type change_info, type uid, is_active } from "../uobj_common";
import { type qbo_vendor_write } from "./vendor_api";

// Mirrors sc_entity_flag in uber's sc/subcontractor.h.
export const SC_ENTITY_FLAG_USE_OWNER_NAME = 1 << 0;
export const SC_ENTITY_FLAG_USE_OWNER_SSN = 1 << 1;
export const SC_ENTITY_FLAG_USE_OWNER_EMAIL = 1 << 2;
export const SC_ENTITY_FLAG_USE_OWNER_ADDRESS = 1 << 3;
export const SC_ENTITY_FLAG_USE_OWNER_NOTES = 1 << 4;
export const SC_ENTITY_FLAG_USE_OWNER_PHONE = 1 << 5;
export const SC_ENTITY_FLAG_USE_OWNER_ALL = 0x3f;

// Mirrors sc_entity_type, stored as an int. 0 is "Sole Proprietor/Single Member LLC";
// anything else is "Multi Member LLC/Corp".
export const SC_ENTITY_TYPE_SOLE_PROPRIETER = 0;

// Mirrors sc_worker_flag.
const SC_WORKER_FLAG_OWNER = 1 << 0;

export type us_address = {
    zip: string;
    city: string;
    state: string;
    street_addr1: string;
    street_addr2: string;
};

export type sc_worker = {
    hres_id: uid;
    flags: number;
};

// Older subcontractor docs predate flags/entity_type/workers; uber fills the
// struct defaults (USE_OWNER_ALL, sole proprietor, no workers) when they're absent,
// so those fields are optional here and defaulted the same way.
export type subc_doc = {
    _id: string;
    name: string;
    ein: string;
    email: string;
    phone_number: string;
    notes: string;
    phys_address: us_address;
    mail_address: us_address;
    flags?: number;
    entity_type?: number;
    workers?: sc_worker[];
    archived_info: change_info;
    last_update: change_info;
};

export type hresource_doc = {
    _id: string;
    first_name: string;
    last_name: string;
    email: string;
    phone_number: string;
    detail?: {
        SSN?: string;
        phys?: us_address;
        mail?: us_address;
    };
    archived_info: change_info;
    last_update: change_info;
};

// The owner hresource fields that can flow into a vendor. An hresource edit that
// touches none of these still bumps last_update; vendor_hash makes that a no-op.
export const OWNER_PROJECTION = {
    _id: 1,
    first_name: 1,
    last_name: 1,
    email: 1,
    phone_number: 1,
    "detail.SSN": 1,
    "detail.phys": 1,
    "detail.mail": 1,
    last_update: 1,
    archived_info: 1,
} as const;

export function subc_flags(sc: subc_doc): number {
    return sc.flags ?? SC_ENTITY_FLAG_USE_OWNER_ALL;
}

// get_sc_owner: the first worker carrying the OWNER flag.
export function get_owner_hres_id(sc: subc_doc): string | null {
    const w = (sc.workers ?? []).find((w) => (w.flags & SC_WORKER_FLAG_OWNER) !== 0);
    return w?.hres_id?.source_str || null;
}

// True if an owner edit can change this subc's vendor. DisplayName always includes the
// owner's name, so that's any subc with an owner, whatever its flags.
export function uses_owner(sc: subc_doc): boolean {
    return get_owner_hres_id(sc) !== null;
}

export function get_subc_log_str(sc: subc_doc): string {
    return `"${sc.name}" (${sc._id})`;
}

const EMPTY_ADDR: us_address = { zip: "", city: "", state: "", street_addr1: "", street_addr2: "" };

function trim(s: string | undefined | null): string {
    return (s ?? "").trim();
}

// Name, email, phone and address follow uber's get_sc_* helpers: use the owner's value
// when the matching USE_OWNER flag is set AND the owner hresource exists, otherwise the
// subc's own value (even if the flag is set). Keep these in step with
// sc/subcontractor.cpp. The person name fields and tin deliberately don't use the flags -
// see resolve_subc.
export type resolved_subc = {
    display_name: string;
    name: string; // the payee name, per USE_OWNER_NAME
    given_name: string; // always the owner's, whatever the flag; empty with no owner
    family_name: string;
    name_from_owner: boolean;
    tin: string; // digits only
    tin_from_owner: boolean; // owner SSN vs the subc's own EIN, per entity type
    email: string;
    phone: string;
    address: us_address;
    active: boolean;
};

// "Owner First Last (Company Name)" when the company name is in use, otherwise just the
// owner's name. `company_name` is empty when USE_OWNER_NAME applies. A company named
// after its owner isn't repeated, and a subc with no owner is just its company name.
function build_display_name(owner_name: string, company_name: string): string {
    if (!owner_name) return company_name;
    if (
        !company_name ||
        clean_display_name(company_name).toLowerCase() === clean_display_name(owner_name).toLowerCase()
    ) {
        return owner_name;
    }
    return `${owner_name} (${company_name})`;
}

export function resolve_subc(sc: subc_doc, owner: hresource_doc | null): resolved_subc {
    const flags = subc_flags(sc);
    const use = (flag: number) => (flags & flag) !== 0 && owner !== null;

    const name_from_owner = use(SC_ENTITY_FLAG_USE_OWNER_NAME);

    // By business classification, not USE_OWNER_SSN: a single member LLC can have an EIN
    // on file but still reports under the owner's SSN. There's no fallback to the EIN,
    // so a sole proprietor without an owner SSN shows up as missing its tax id.
    const tin_from_owner = (sc.entity_type ?? SC_ENTITY_TYPE_SOLE_PROPRIETER) === SC_ENTITY_TYPE_SOLE_PROPRIETER;

    // get_sc_mail_address / get_sc_phys_address share the ADDRESS flag. The vendor
    // gets the mailing address (where the 1099 goes), falling back to physical when
    // no mailing street is on file.
    const addr_src = use(SC_ENTITY_FLAG_USE_OWNER_ADDRESS)
        ? { mail: owner!.detail?.mail, phys: owner!.detail?.phys }
        : { mail: sc.mail_address, phys: sc.phys_address };
    const address = trim(addr_src.mail?.street_addr1) ? addr_src.mail! : (addr_src.phys ?? EMPTY_ADDR);

    const given_name = trim(owner?.first_name);
    const family_name = trim(owner?.last_name);

    // name_first_last for the owner, same as get_sc_name(..., last_comma_first=false)
    const owner_name = `${given_name} ${family_name}`.trim();
    const subc_name = trim(sc.name);

    return {
        display_name: build_display_name(owner_name, name_from_owner ? "" : subc_name),
        name: name_from_owner ? owner_name : subc_name,
        given_name,
        family_name,
        name_from_owner,
        tin: (tin_from_owner ? (owner?.detail?.SSN ?? "") : sc.ein).replace(/\D/g, ""),
        tin_from_owner,
        email: trim(use(SC_ENTITY_FLAG_USE_OWNER_EMAIL) ? owner!.email : sc.email),
        phone: trim(use(SC_ENTITY_FLAG_USE_OWNER_PHONE) ? owner!.phone_number : sc.phone_number),
        address: {
            zip: trim(address.zip),
            city: trim(address.city),
            state: trim(address.state),
            street_addr1: trim(address.street_addr1),
            street_addr2: trim(address.street_addr2),
        },
        active: is_active(sc.archived_info.on),
    };
}

// What a 1099 vendor needs. Until all of these are present the subc is skipped
// (without flooring the cursor) - filling them in bumps the subc/owner and the delta
// pass picks it up then.
export function missing_required_fields(r: resolved_subc): string[] {
    const missing: string[] = [];
    if (!r.name) missing.push("name");
    const tin_label = r.tin_from_owner ? "owner SSN" : "EIN";
    if (r.tin.length !== 9) missing.push(r.tin ? `${tin_label} (${r.tin.length} digits, need 9)` : tin_label);
    if (!r.address.street_addr1) missing.push("street address");
    if (!r.address.city) missing.push("city");
    if (!r.address.state) missing.push("state");
    if (!r.address.zip) missing.push("zip");
    return missing;
}

// QBO name fields can't contain colons, tabs or newlines. DisplayName must also be
// unique across vendors, customers and employees.
function clean_display_name(s: string): string {
    return s
        .replace(/[:\t\r\n]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
}

// QBO requires an @ and a dot. Sending anything else would fail the whole vendor, so a
// bad address is left out instead (see the email warning in preview).
export function is_valid_email(s: string): boolean {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

// What the vendor's Contractor Type should be in QuickBooks. The API doesn't expose that
// setting, so preview lists this for someone to set by hand.
export function get_contractor_type(r: resolved_subc): "Individual" | "Business" {
    return r.tin_from_owner ? "Individual" : "Business";
}

function format_tin(digits: string, is_ssn: boolean): string {
    return is_ssn
        ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
        : `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

// The full set of vendor fields we own. Built in a fixed key order so vendor_hash is
// stable. Fields we leave out (terms, accounts, notes) stay under accounting's control.
export function build_vendor_payload(r: resolved_subc): qbo_vendor_write {
    const payee = clean_display_name(r.name);
    const v: qbo_vendor_write = {
        DisplayName: clean_display_name(r.display_name),
        PrintOnCheckName: payee.slice(0, 110),
        Active: r.active,
        Vendor1099: true,
        TaxIdentifier: format_tin(r.tin, r.tin_from_owner),
        BillAddr: {
            Line1: r.address.street_addr1,
            Line2: r.address.street_addr2,
            City: r.address.city,
            CountrySubDivisionCode: r.address.state,
            PostalCode: r.address.zip,
        },
    };
    if (r.given_name) v.GivenName = clean_display_name(r.given_name).slice(0, 100);
    if (r.family_name) v.FamilyName = clean_display_name(r.family_name).slice(0, 100);
    // Sent empty rather than left out, since a sparse update wouldn't clear an old value.
    v.CompanyName = r.name_from_owner ? "" : payee.slice(0, 100);
    if (is_valid_email(r.email)) v.PrimaryEmailAddr = { Address: r.email };
    if (r.phone) v.PrimaryPhone = { FreeFormNumber: r.phone };
    return v;
}

// Keyed so the stored value can't be brute-forced back to a TIN (see config).
export function vendor_hash(v: qbo_vendor_write): string {
    return createHmac("sha256", config.sync_hash_key).update(JSON.stringify(v)).digest("hex");
}

// For logs/preview: never print a full TIN.
export function redact_payload(v: qbo_vendor_write): qbo_vendor_write {
    return v.TaxIdentifier ? { ...v, TaxIdentifier: `***${v.TaxIdentifier.slice(-4)}` } : v;
}
