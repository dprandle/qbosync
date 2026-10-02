import { config } from "../config";
import { qbo_rate_limiter } from "./rate_limiter";
import { get_connection } from "./auth";

// Generic QBO accounting API client. Entity-specific helpers (vendors/vendor_api.ts,
// and later expenses etc.) build on these few calls, so every feature shares one
// token, one rate limiter and one error classification.

const BASE_URLS = {
    sandbox: "https://sandbox-quickbooks.api.intuit.com",
    production: "https://quickbooks.api.intuit.com",
};

// QBO caps query results at 1000 per page.
export const QUERY_PAGE_SIZE = 1000;

// QBO error codes that are ValidationFaults but resolve on retry. 5010 = stale
// SyncToken (someone edited the entity between our read and write).
const TRANSIENT_FAULT_CODES = new Set(["5010"]);

// "Object Not Found" comes back as a 400 ValidationFault with code 610.
const NOT_FOUND_CODE = "610";

// Fields every QBO entity carries.
export type qbo_entity = {
    Id: string;
    SyncToken: string;
    MetaData?: { CreateTime: string; LastUpdatedTime: string };
};

// permanent: QBO rejected the data itself (validation, duplicate name) - retrying the
// same payload will fail the same way, so callers record it and move on rather than
// retrying. Everything else (network, 5xx, 429, auth, stale SyncToken) is transient.
export class qbo_api_error extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly fault_type: string,
        readonly codes: string[],
        readonly permanent: boolean
    ) {
        super(message);
        this.name = "qbo_api_error";
    }
}

function parse_fault(status: number, method: string, path: string, text: string): qbo_api_error {
    let fault_type = "";
    let codes: string[] = [];
    let detail = text;
    try {
        const body = JSON.parse(text);
        const fault = body.Fault ?? body.fault;
        if (fault) {
            fault_type = fault.type ?? "";
            const errs: any[] = fault.Error ?? fault.error ?? [];
            codes = errs.map((e) => String(e.code ?? ""));
            detail = errs.map((e) => `${e.code}: ${e.Message ?? e.message} - ${e.Detail ?? e.detail ?? ""}`).join("; ");
        }
    } catch {
        // Non-JSON body (gateway errors etc.) - keep the raw text.
    }
    const permanent =
        status === 400 && fault_type === "ValidationFault" && !codes.some((c) => TRANSIENT_FAULT_CODES.has(c));
    return new qbo_api_error(
        `QBO ${method} ${path} ${status} ${fault_type}: ${detail}`,
        status,
        fault_type,
        codes,
        permanent
    );
}

async function qbo_request(method: "GET" | "POST", path: string, params: Record<string, string>, body?: unknown) {
    for (let attempt = 0; ; ++attempt) {
        const conn = await get_connection(attempt > 0);
        const url = new URL(`${BASE_URLS[config.qbo_env]}/v3/company/${conn.realm_id}${path}`);
        url.searchParams.set("minorversion", config.qbo_minor_version);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

        await qbo_rate_limiter.acquire();
        const resp = await fetch(url.toString(), {
            method,
            headers: {
                Authorization: `Bearer ${conn.access_token}`,
                Accept: "application/json",
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        // A 401 with a token we believed valid (revoked, clock skew): force one
        // refresh and retry before treating it as an error.
        if (resp.status === 401 && attempt === 0) {
            wlog(`[qbo] 401 on ${method} ${path} - forcing token refresh and retrying`);
            continue;
        }
        const text = await resp.text();
        if (!resp.ok) throw parse_fault(resp.status, method, path, text);
        return JSON.parse(text);
    }
}

// QBO query language uses single-quoted strings with backslash escapes.
export function q_str(s: string): string {
    return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// `entity` is the QBO entity name as it appears in responses ("Vendor", "Purchase",
// "Bill"); its lowercase form is the REST path segment.
export class qbo_client {
    // Returns null when the entity doesn't exist in this realm.
    async read<T extends qbo_entity>(entity: string, id: string): Promise<T | null> {
        try {
            const res = await qbo_request("GET", `/${entity.toLowerCase()}/${encodeURIComponent(id)}`, {});
            return res[entity] as T;
        } catch (err) {
            if (err instanceof qbo_api_error && err.codes.includes(NOT_FOUND_CODE)) return null;
            throw err;
        }
    }

    async create<T extends qbo_entity>(entity: string, body: object): Promise<T> {
        const res = await qbo_request("POST", `/${entity.toLowerCase()}`, {}, body);
        return res[entity] as T;
    }

    // Sparse update: only the fields present in `body` change; everything else on the
    // entity is left alone.
    async sparse_update<T extends qbo_entity>(
        entity: string,
        id: string,
        sync_token: string,
        body: object
    ): Promise<T> {
        const res = await qbo_request(
            "POST",
            `/${entity.toLowerCase()}`,
            {},
            { ...body, Id: id, SyncToken: sync_token, sparse: true }
        );
        return res[entity] as T;
    }

    // One query page. `where` is raw QBO query syntax (quote strings with q_str).
    async query<T>(entity: string, where = "", start = 1, max = QUERY_PAGE_SIZE): Promise<T[]> {
        const query = `select * from ${entity}${where ? ` where ${where}` : ""} startposition ${start} maxresults ${max}`;
        const res = await qbo_request("GET", "/query", { query });
        return (res.QueryResponse?.[entity] ?? []) as T[];
    }

    // Every matching row, paging through QUERY_PAGE_SIZE at a time.
    async query_all<T>(entity: string, where = ""): Promise<T[]> {
        const out: T[] = [];
        for (let start = 1; ; start += QUERY_PAGE_SIZE) {
            const page = await this.query<T>(entity, where, start);
            out.push(...page);
            if (page.length < QUERY_PAGE_SIZE) return out;
        }
    }
}
