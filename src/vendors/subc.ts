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

// True if any vendor field is pulled from the owner, i.e. an owner edit can change
// this subc's vendor.
export function uses_owner(sc: subc_doc): boolean {
    return (subc_flags(sc) & SC_ENTITY_FLAG_USE_OWNER_ALL) !== 0 && get_owner_hres_id(sc) !== null;
}

export function get_subc_log_str(sc: subc_doc): string {
    return `"${sc.name}" (${sc._id})`;
}

const EMPTY_ADDR: us_address = { zip: "", city: "", state: "", street_addr1: "", street_addr2: "" };

function trim(s: string | undefined | null): string {
    return (s ?? "").trim();
}

// Each field follows uber's get_sc_* helpers exactly: use the owner's value when the
// matching USE_OWNER flag is set AND the owner hresource exists, otherwise the subc's
// own value (even if the flag is set). Keep these in step with sc/subcontractor.cpp.
export type resolved_subc = {
    name: string;
    given_name: string; // set only when the name came from the owner
    family_name: string;
    name_from_owner: boolean;
    tin: string; // digits only
    tin_from_owner: boolean; // owner SSN vs the subc's own EIN
    email: string;
    phone: string;
    address: us_address;
    active: boolean;
};

export function resolve_subc(sc: subc_doc, owner: hresource_doc | null): resolved_subc {
    const flags = subc_flags(sc);
    const use = (flag: number) => (flags & flag) !== 0 && owner !== null;

    const name_from_owner = use(SC_ENTITY_FLAG_USE_OWNER_NAME);
    const tin_from_owner = use(SC_ENTITY_FLAG_USE_OWNER_SSN);

    // get_sc_mail_address / get_sc_phys_address share the ADDRESS flag. The vendor
    // gets the mailing address (where the 1099 goes), falling back to physical when
    // no mailing street is on file.
    const addr_src = use(SC_ENTITY_FLAG_USE_OWNER_ADDRESS)
        ? { mail: owner!.detail?.mail, phys: owner!.detail?.phys }
        : { mail: sc.mail_address, phys: sc.phys_address };
    const address = trim(addr_src.mail?.street_addr1) ? addr_src.mail! : (addr_src.phys ?? EMPTY_ADDR);

    const given_name = name_from_owner ? trim(owner!.first_name) : "";
    const family_name = name_from_owner ? trim(owner!.last_name) : "";

    return {
        // name_first_last for the owner, same as get_sc_name(..., last_comma_first=false)
        name: name_from_owner ? `${given_name} ${family_name}`.trim() : trim(sc.name),
        given_name,
        family_name,
        name_from_owner,
        tin: (tin_from_owner ? (owner!.detail?.SSN ?? "") : sc.ein).replace(/\D/g, ""),
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
    if (r.tin.length !== 9) missing.push(r.tin ? `tax id (${r.tin.length} digits, need 9)` : "tax id");
    if (!r.address.street_addr1) missing.push("street address");
    if (!r.address.city) missing.push("city");
    if (!r.address.state) missing.push("state");
    if (!r.address.zip) missing.push("zip");
    return missing;
}

// QBO DisplayName can't contain colons, tabs or newlines, and must be unique across
// vendors, customers and employees.
function clean_display_name(s: string): string {
    return s
        .replace(/[:\t\r\n]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
}

function format_tin(digits: string, is_ssn: boolean): string {
    return is_ssn
        ? `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
        : `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

// The full set of vendor fields we own. Built in a fixed key order so vendor_hash is
// stable. Fields we leave out (terms, accounts, notes) stay under accounting's control.
export function build_vendor_payload(r: resolved_subc): qbo_vendor_write {
    const display = clean_display_name(r.name);
    const v: qbo_vendor_write = {
        DisplayName: display,
        PrintOnCheckName: display.slice(0, 110),
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
    if (r.name_from_owner) {
        v.GivenName = r.given_name.slice(0, 100);
        v.FamilyName = r.family_name.slice(0, 100);
    } else {
        v.CompanyName = display.slice(0, 100);
    }
    if (r.email.includes("@")) v.PrimaryEmailAddr = { Address: r.email };
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
