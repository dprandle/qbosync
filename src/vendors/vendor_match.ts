import { type qbo_vendor } from "./vendor_api";
import { type subc_doc, type hresource_doc } from "./subc";

// How bootstrap decides a QBO vendor might belong to a subc. No I/O, so the rules can be
// exercised without QuickBooks or Mongo.

// Strongest first.
export const MATCH_OWNER_FIELDS = 0; // owner's name = the vendor's GivenName/FamilyName
export const MATCH_NAME = 1; // any exact name form, on either side
export const MATCH_LOOSE = 2; // one name's words all appear in the other (1099 vendors only)
export const MATCH_TIN_ONLY = 3; // no name in common, last-4 agrees (1099 vendors only)

export type tin_status = "match" | "unknown" | "mismatch";

export type vendor_match = {
    vendor: qbo_vendor;
    rank: number;
    tin: tin_status;
};

export type subc_candidates = {
    sc: subc_doc;
    matches: vendor_match[]; // strongest first
};

export type auto_link = {
    sc: subc_doc;
    match: vendor_match;
};

// Lowercase, minus trailing business suffixes, so "ABC Trucking, LLC" and "abc trucking"
// collide.
function strip_name(s: string | undefined): string {
    return (s ?? "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/\b(llc|l\.l\.c|inc|co|corp|corporation|company|ltd)\b\.?/g, "");
}

function norm_name(s: string | undefined): string {
    return strip_name(s).replace(/[^a-z0-9]/g, "");
}

// Single letters are dropped so a middle initial doesn't get in the way.
function name_tokens(s: string | undefined): string[] {
    return strip_name(s)
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1);
}

export function last4(s: string | undefined): string {
    return (s ?? "").replace(/\D/g, "").slice(-4);
}

function norm_set(names: (string | undefined)[]): Set<string> {
    return new Set(names.map(norm_name).filter(Boolean));
}

function intersects(a: Set<string>, b: Set<string>): boolean {
    return [...a].some((k) => b.has(k));
}

// True when every word of the shorter name appears in the longer, which catches
// "Jane A Doe", "Doe, Jane" and "Jane Doe dba ABC Trucking". The shorter name needs two
// words, or a lone "Smith" would match every Smith.
function loose_name_match(a: string | undefined, b: string | undefined): boolean {
    const [ta, tb] = [name_tokens(a), name_tokens(b)];
    const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    if (short.length < 2) return false;
    const long_set = new Set(long);
    return short.every((t) => long_set.has(t));
}

// A vendor's tax ID may be either one regardless of the subc's classification: a single
// member LLC could have been entered under its EIN and will get the owner's SSN later.
function our_tin_last4s(sc: subc_doc, owner: hresource_doc | null): Set<string> {
    const digits = [sc.ein, owner?.detail?.SSN].map((s) => (s ?? "").replace(/\D/g, ""));
    return new Set(digits.filter((d) => d.length === 9).map(last4));
}

function get_tin_status(v: qbo_vendor, ours: Set<string>): tin_status {
    const theirs = last4(v.TaxIdentifier);
    if (!theirs || ours.size === 0) return "unknown";
    return ours.has(theirs) ? "match" : "mismatch";
}

export function get_vendor_tin_status(sc: subc_doc, owner: hresource_doc | null, v: qbo_vendor): tin_status {
    return get_tin_status(v, our_tin_last4s(sc, owner));
}

export function match_vendor(sc: subc_doc, owner: hresource_doc | null, v: qbo_vendor): vendor_match | null {
    const tin = get_vendor_tin_status(sc, owner, v);
    const owner_name = owner ? `${owner.first_name} ${owner.last_name}` : "";
    const owner_keys = norm_set(owner ? [owner_name, `${owner.last_name} ${owner.first_name}`] : []);
    const subc_keys = new Set([...owner_keys, ...norm_set([sc.name])]);

    const has_fields = Boolean(v.GivenName || v.FamilyName);
    const field_names = has_fields
        ? [`${v.GivenName ?? ""} ${v.FamilyName ?? ""}`, `${v.FamilyName ?? ""} ${v.GivenName ?? ""}`]
        : [];
    const field_keys = norm_set(field_names);
    const other_names = [v.DisplayName, v.CompanyName, v.PrintOnCheckName];
    const vendor_keys = new Set([...field_keys, ...norm_set(other_names)]);

    if (intersects(owner_keys, field_keys)) return { vendor: v, rank: MATCH_OWNER_FIELDS, tin };
    if (intersects(subc_keys, vendor_keys)) return { vendor: v, rank: MATCH_NAME, tin };

    // Loose and TIN-only matches would be noise against the suppliers and utilities in
    // the books, so they're limited to vendors that should be subcs.
    if (!v.Vendor1099) return null;
    const vendor_names = [...field_names, ...other_names];
    const is_loose = [sc.name, owner_name].some((a) => vendor_names.some((b) => loose_name_match(a, b)));
    if (is_loose) return { vendor: v, rank: MATCH_LOOSE, tin };
    if (tin === "match") return { vendor: v, rank: MATCH_TIN_ONLY, tin };
    return null;
}

// All of a subc's possible vendors, best first: by match type, then a confirmed TIN, then
// active over inactive.
export function match_vendors(sc: subc_doc, owner: hresource_doc | null, vendors: qbo_vendor[]): vendor_match[] {
    return vendors
        .map((v) => match_vendor(sc, owner, v))
        .filter((m): m is vendor_match => m !== null)
        .sort(
            (a, b) =>
                a.rank - b.rank ||
                Number(b.tin === "match") - Number(a.tin === "match") ||
                Number(b.vendor.Active) - Number(a.vendor.Active)
        );
}

// A vendor could belong to this subc unless its visible TIN says otherwise.
export function is_plausible(m: vendor_match): boolean {
    return m.tin !== "mismatch";
}

// The vendor this subc can safely link to without asking: an exact name plus a last-4
// match, and no other plausible vendor. A second candidate may be a duplicate, and which
// one has the payment history is a human's call.
function pick_auto(matches: vendor_match[]): vendor_match | null {
    const plausible = matches.filter(is_plausible);
    if (plausible.length !== 1) return null;
    const [m] = plausible;
    return m.tin === "match" && (m.rank === MATCH_OWNER_FIELDS || m.rank === MATCH_NAME) ? m : null;
}

// A vendor claimed by two subcs is left for a human: an owner with two subcs has the
// same name and SSN on both, so neither one is the obvious answer.
export function find_auto_links(group: subc_candidates[]): auto_link[] {
    const picks: auto_link[] = [];
    const claims = new Map<string, number>();
    for (const { sc, matches } of group) {
        const match = pick_auto(matches);
        if (!match) continue;
        picks.push({ sc, match });
        claims.set(match.vendor.Id, (claims.get(match.vendor.Id) ?? 0) + 1);
    }
    return picks.filter((p) => claims.get(p.match.vendor.Id) === 1);
}
