import { createHmac } from "crypto";
import { config } from "../config";
import { type change_info, type uid, is_active } from "../uobj_common";
import { type qbo_vendor_write } from "./vendor_api";

// Mirrors sc_entity_flag in uber's sc/subcontractor.h.
export const SC_ENTITY_FLAG_USE_OWNER_NAME = 1 << 0;
// 1 << 1 was USE_OWNER_SSN. The tax id now goes by entity type alone - see resolve_subc.
export const SC_ENTITY_FLAG_USE_OWNER_EMAIL = 1 << 2;
export const SC_ENTITY_FLAG_USE_OWNER_ADDRESS = 1 << 3;
export const SC_ENTITY_FLAG_USE_OWNER_NOTES = 1 << 4;
export const SC_ENTITY_FLAG_USE_OWNER_PHONE = 1 << 5;
export const SC_ENTITY_FLAG_USE_OWNER_ALL = 0x3f;

// The first two values of sc_entity_type in uber's sc/subcontractor.h, stored as an int.
// The later values (multi member LLC, partnership, corps, other) are all treated alike.
const SC_ENTITY_TYPE_SOLE_PROPRIETOR = 0;
const SC_ENTITY_TYPE_SINGLE_MEMBER_LLC = 1;

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

// Same as is_disregarded in uber's sc/subcontractor.cpp. A disregarded entity reports under
// its owner. A doc with no entity_type gets uber's default, sole proprietor.
export function is_disregarded_entity(sc: subc_doc): boolean {
    const entity_type = sc.entity_type ?? SC_ENTITY_TYPE_SOLE_PROPRIETOR;
    return entity_type === SC_ENTITY_TYPE_SOLE_PROPRIETOR || entity_type === SC_ENTITY_TYPE_SINGLE_MEMBER_LLC;
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

// The owner hresource for a subc out of a map loaded by load_owners, or null when the
// subc has no owner or the owner isn't in the map.
export function get_subc_owner(sc: subc_doc, owners: Map<string, hresource_doc>): hresource_doc | null {
    const owner_id = get_owner_hres_id(sc);
    return owner_id ? (owners.get(owner_id) ?? null) : null;
}

// For logs and alert emails: the payee name the vendor gets (resolved_subc.name), so a
// sole proprietor going by the owner's name is reported that way too.
export function get_subc_log_str(sc: subc_doc, owner: hresource_doc | null): string {
    return `"${resolve_subc(sc, owner).name}" (${sc._id})`;
}

const EMPTY_ADDR: us_address = { zip: "", city: "", state: "", street_addr1: "", street_addr2: "" };

function trim(s: string | undefined | null): string {
    return (s ?? "").trim();
}

// Name, email, phone and address follow uber's get_sc_* helpers: use the owner's value
// when the matching USE_OWNER flag is set AND the owner hresource exists, otherwise the
// subc's own value (even if the flag is set). Keep these in step with
// sc/subcontractor.cpp. The vendor's name fields and tin go by business classification
// instead - see resolve_subc.
export type resolved_subc = {
    display_name: string;
    name: string; // the payee name, per USE_OWNER_NAME
    given_name: string;
    family_name: string;
    company_name: string;
    tin: string; // digits only
    tin_from_owner: boolean; // owner SSN vs the subc's own EIN, per entity type
    email: string;
    phone: string;
    address: us_address;
    active: boolean;
};

// "Owner First Last (Subc Name)". The parentheses stay when the subc name is empty, so
// the gap shows in QBO, except for a sole proprietor, who is then just the owner. A
// subc with no owner is just its own name.
function build_display_name(owner_name: string, subc_name: string, sole_proprietor: boolean): string {
    if (!owner_name) return subc_name;
    if (!subc_name && sole_proprietor) return owner_name;
    return `${owner_name} (${subc_name})`;
}

export function resolve_subc(sc: subc_doc, owner: hresource_doc | null): resolved_subc {
    const flags = subc_flags(sc);
    const use = (flag: number) => (flags & flag) !== 0 && owner !== null;

    // By entity type alone: a single member LLC can have an EIN on file but still reports
    // under the owner's SSN. There's no fallback between the two, so a subc without the one
    // it needs shows up as missing its tax id.
    const entity_type = sc.entity_type ?? SC_ENTITY_TYPE_SOLE_PROPRIETOR;
    const tin_from_owner = is_disregarded_entity(sc);
    const sole_proprietor = entity_type === SC_ENTITY_TYPE_SOLE_PROPRIETOR;
    const single_member_llc = entity_type === SC_ENTITY_TYPE_SINGLE_MEMBER_LLC;

    // Uber disables the name flag for entities that aren't disregarded, so a value left over
    // on an older doc is ignored: those always use the subc's own name.
    const name_from_owner = tin_from_owner && use(SC_ENTITY_FLAG_USE_OWNER_NAME);

    // get_sc_mail_address / get_sc_phys_address share the ADDRESS flag. The vendor
    // gets the mailing address (where the 1099 goes), falling back to physical when
    // no mailing street is on file.
    const addr_src = use(SC_ENTITY_FLAG_USE_OWNER_ADDRESS)
        ? { mail: owner!.detail?.mail, phys: owner!.detail?.phys }
        : { mail: sc.mail_address, phys: sc.phys_address };
    const address = trim(addr_src.mail?.street_addr1) ? addr_src.mail! : (addr_src.phys ?? EMPTY_ADDR);

    const owner_first = trim(owner?.first_name);
    const owner_last = trim(owner?.last_name);

    // name_first_last for the owner, same as get_sc_name(..., last_comma_first=false)
    const owner_name = `${owner_first} ${owner_last}`.trim();
    const subc_name = trim(sc.name);

    // QBO has no Contractor Type field; it works the type out from these. A person name
    // makes a vendor Individual even with an EIN, so Business takes an EIN, a company name
    // and no person name.
    const is_individual = tin_from_owner;

    // The name fields by entity type (the README has the table):
    //   Sole proprietor + USE_OWNER_NAME: no company; payee and display are the owner.
    //   Single member LLC + USE_OWNER_NAME: company, payee and display are "Owner LLC".
    //   Otherwise: company and payee are the subc name, display "Owner (Subc Name)".
    let company_name: string;
    let name: string;
    let display_name: string;
    if (name_from_owner) {
        name = single_member_llc ? `${owner_name} LLC` : owner_name;
        company_name = single_member_llc ? name : "";
        display_name = name;
    } else {
        name = subc_name;
        company_name = subc_name;
        display_name = build_display_name(owner_name, subc_name, sole_proprietor);
    }

    return {
        display_name,
        name,
        given_name: is_individual ? owner_first : "",
        family_name: is_individual ? owner_last : "",
        company_name,
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
    // QBO shows the vendor's personal info as missing without the name its type needs.
    if (!r.tin_from_owner) {
        if (!r.company_name) missing.push("company name");
    } else if (!r.given_name && !r.family_name) {
        missing.push("owner name");
    } else if (!r.name) {
        missing.push("name");
    }
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

// The Contractor Type QBO should work out from the fields we send. Preview shows it so the
// result can be checked by eye.
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
    const v: qbo_vendor_write = {
        DisplayName: clean_display_name(r.display_name),
        PrintOnCheckName: clean_display_name(r.name).slice(0, 110),
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
    // Sent even when empty: a sparse update wouldn't clear an old value otherwise, and a
    // leftover person name would make a Business vendor Individual.
    v.GivenName = clean_display_name(r.given_name).slice(0, 100);
    v.FamilyName = clean_display_name(r.family_name).slice(0, 100);
    v.CompanyName = clean_display_name(r.company_name).slice(0, 100);
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
