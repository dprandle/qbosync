import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { config } from "../config";
import { send_alert } from "../alerts";

// qbosync is the sole owner of the QBO OAuth connection: it holds the client
// secret, performs the code exchange, stores the tokens, and is the only process
// that ever refreshes them. Intuit rotates refresh tokens, so a second refresher
// would invalidate ours. zetrick-api only forwards the browser-facing /quickbooks
// routes to our loopback API server (api_server.ts, oauth_routes.ts), since Intuit
// needs a public URL.

const QBO_SCOPE = "com.intuit.quickbooks.accounting";
const QBO_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

// Refresh this long before the access token (1h lifetime) actually expires.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// Same field names as zetrick-api's old /var/lib/zetrick/quickbooks.json, so an
// existing connection can be carried over by copying that file to QBO_TOKEN_FILE.
export type qbo_connection = {
    realm_id: string;
    access_token: string;
    refresh_token: string;
    access_token_expires_at: Date;
    refresh_token_expires_at: Date;
    connected_at: Date;
};

type qbo_token_response = {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    x_refresh_token_expires_in: number;
    token_type: string;
};

export class qbo_not_connected_error extends Error {
    constructor(message: string) {
        super(message);
        this.name = "qbo_not_connected_error";
    }
}

let cached: qbo_connection | null | undefined;
let refresh_in_flight: Promise<qbo_connection> | null = null;
let dead_alerted_at = 0;
const oauth_states = new Map<string, number>();

function parse_connection(raw: any): qbo_connection {
    return {
        realm_id: String(raw.realm_id),
        access_token: raw.access_token,
        refresh_token: raw.refresh_token,
        access_token_expires_at: new Date(raw.access_token_expires_at),
        refresh_token_expires_at: new Date(raw.refresh_token_expires_at),
        connected_at: new Date(raw.connected_at),
    };
}

// Re-read whenever the file changes on disk: scripts like `npm run bootstrap_vendors`
// run as separate processes against the same token file while the service is up, and
// may refresh (rotate) the tokens. A stale cached refresh token would then fail.
let cached_mtime = 0;

export function load_connection(): qbo_connection | null {
    if (!existsSync(config.qbo_token_file)) {
        cached = null;
        return null;
    }
    const mtime = statSync(config.qbo_token_file).mtimeMs;
    if (cached === undefined || cached === null || mtime !== cached_mtime) {
        cached = parse_connection(JSON.parse(readFileSync(config.qbo_token_file, "utf-8")));
        cached_mtime = mtime;
    }
    return cached;
}

// tmp + rename so a crash mid-write can't leave a truncated token file (which would
// lose the only copy of the rotated refresh token).
function save_connection(conn: qbo_connection): void {
    mkdirSync(dirname(resolve(config.qbo_token_file)), { recursive: true });
    const tmp = `${config.qbo_token_file}.tmp`;
    writeFileSync(tmp, JSON.stringify(conn, null, 4), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, config.qbo_token_file);
    cached = conn;
    cached_mtime = statSync(config.qbo_token_file).mtimeMs;
}

export function realm_allowed(realm_id: string): boolean {
    return !config.qbo_expected_realm_id || config.qbo_expected_realm_id === realm_id;
}

async function token_request(body: Record<string, string>): Promise<qbo_token_response> {
    const basic = Buffer.from(`${config.qbo_client_id}:${config.qbo_client_secret}`).toString("base64");
    const resp = await fetch(QBO_TOKEN_URL, {
        method: "POST",
        headers: {
            Authorization: `Basic ${basic}`,
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(body),
    });
    if (!resp.ok) {
        const text = await resp.text();
        const err = new Error(`QBO token request (${body.grant_type}) failed ${resp.status}: ${text}`);
        (err as any).status = resp.status;
        (err as any).invalid_grant = text.includes("invalid_grant");
        throw err;
    }
    return (await resp.json()) as qbo_token_response;
}

function connection_from_tokens(realm_id: string, t: qbo_token_response, connected_at: Date): qbo_connection {
    const now = Date.now();
    return {
        realm_id,
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        access_token_expires_at: new Date(now + t.expires_in * 1000),
        refresh_token_expires_at: new Date(now + t.x_refresh_token_expires_in * 1000),
        connected_at,
    };
}

async function alert_connection_dead(reason: string): Promise<void> {
    // At most one email per realert window per process; the sync keeps failing
    // (and logging) every tick until someone reconnects.
    if (Date.now() - dead_alerted_at < config.cursor_floor_realert_hours * 3_600_000) return;
    dead_alerted_at = Date.now();
    try {
        await send_alert(
            "QuickBooks connection lost",
            `qbosync can no longer refresh its QuickBooks Online token:\n\n${reason}\n\n` +
                `Reconnect at https://<zetrick-api host>/quickbooks/connect. Vendor sync is paused until then.`
        );
    } catch (err) {
        elog("[qbo-auth] Failed to send connection-lost alert:", err);
    }
}

async function do_refresh(conn: qbo_connection): Promise<qbo_connection> {
    try {
        const t = await token_request({ grant_type: "refresh_token", refresh_token: conn.refresh_token });
        const next = connection_from_tokens(conn.realm_id, t, conn.connected_at);
        save_connection(next);
        ilog(`[qbo-auth] Refreshed access token (expires ${next.access_token_expires_at.toISOString()})`);
        return next;
    } catch (err: any) {
        if (err?.invalid_grant) {
            await alert_connection_dead(String(err));
            throw new qbo_not_connected_error(`QBO refresh token rejected - reconnect required: ${err}`);
        }
        throw err;
    }
}

// Returns a usable connection, refreshing first if the access token is near expiry
// (or `force` after a 401). Concurrent callers share one in-flight refresh so the
// rotated refresh token is only ever spent once.
export async function get_connection(force = false): Promise<qbo_connection> {
    const conn = load_connection();
    if (!conn) throw new qbo_not_connected_error("QuickBooks is not connected - visit /quickbooks/connect");
    if (!realm_allowed(conn.realm_id)) {
        throw new qbo_not_connected_error(
            `Stored QBO realm ${conn.realm_id} does not match QBO_EXPECTED_REALM_ID ${config.qbo_expected_realm_id}`
        );
    }
    if (!force && conn.access_token_expires_at.getTime() - Date.now() > REFRESH_MARGIN_MS) return conn;

    if (!refresh_in_flight) {
        refresh_in_flight = do_refresh(conn).finally(() => {
            refresh_in_flight = null;
        });
    }
    return refresh_in_flight;
}

// ---------------------------------------------------------------------------
// Browser OAuth flow (driven through zetrick-api)
// ---------------------------------------------------------------------------

function cleanup_oauth_states(): void {
    const now = Date.now();
    for (const [state, expires_at] of oauth_states.entries()) {
        if (expires_at < now) oauth_states.delete(state);
    }
}

// Single use: deleted whether valid or expired so it can't be replayed.
function consume_oauth_state(state: string): boolean {
    const expires_at = oauth_states.get(state);
    oauth_states.delete(state);
    return Boolean(expires_at && expires_at >= Date.now());
}

export function create_connect_url(): string {
    cleanup_oauth_states();
    const state = crypto.randomBytes(32).toString("base64url");
    oauth_states.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    const params = new URLSearchParams({
        client_id: config.qbo_client_id,
        response_type: "code",
        scope: QBO_SCOPE,
        redirect_uri: config.qbo_redirect_uri,
        state,
    });
    return `${QBO_AUTH_URL}?${params.toString()}`;
}

export type oauth_callback_params = {
    code?: string;
    state?: string;
    realmId?: string;
    error?: string;
    error_description?: string;
};

export type oauth_callback_result = {
    ok: boolean;
    status: number; // HTTP status zetrick-api should answer the browser with
    title: string;
    message: string;
};

export async function complete_oauth(q: oauth_callback_params): Promise<oauth_callback_result> {
    if (q.error) {
        wlog(`[qbo-auth] Authorization failed: ${q.error} ${q.error_description ?? ""}`);
        return {
            ok: false,
            status: 400,
            title: "QuickBooks Authorization Failed",
            message: q.error_description ?? "QuickBooks authorization was not completed.",
        };
    }
    if (!q.code || !q.state || !q.realmId) {
        return {
            ok: false,
            status: 400,
            title: "Invalid Authorization Response",
            message: "The authorization response from QuickBooks was incomplete.",
        };
    }
    if (!consume_oauth_state(q.state)) {
        wlog("[qbo-auth] Rejected callback with invalid/expired state");
        return {
            ok: false,
            status: 400,
            title: "Authorization Validation Failed",
            message: "The authorization request could not be verified. Please reconnect QuickBooks.",
        };
    }
    if (!realm_allowed(q.realmId)) {
        wlog(`[qbo-auth] Rejected connection to unexpected realm ${q.realmId}`);
        return {
            ok: false,
            status: 400,
            title: "Wrong QuickBooks Company",
            message: `This ${config.qbo_env} deployment only connects to company ${config.qbo_expected_realm_id}.`,
        };
    }

    try {
        const t = await token_request({
            grant_type: "authorization_code",
            code: q.code,
            redirect_uri: config.qbo_redirect_uri,
        });
        save_connection(connection_from_tokens(q.realmId, t, new Date()));
        dead_alerted_at = 0;
        ilog(`[qbo-auth] Connected to QuickBooks realm ${q.realmId} (${config.qbo_env})`);
        return {
            ok: true,
            status: 200,
            title: "QuickBooks Connected",
            message: "Zetrick's QuickBooks Online integration was successfully authorized. You may close this window.",
        };
    } catch (err) {
        // Never log the code or credentials - just the token endpoint's response.
        elog("[qbo-auth] Token exchange failed:", err);
        return {
            ok: false,
            status: 502,
            title: "QuickBooks Connection Failed",
            message: "QuickBooks could not complete the authorization. Please try connecting again.",
        };
    }
}

export type connection_status = {
    connected: boolean;
    qbo_env: string;
    realm_id?: string;
    connected_at?: Date;
    access_token_expires_at?: Date;
    refresh_token_expires_at?: Date;
};

export function get_connection_status(): connection_status {
    const conn = load_connection();
    if (!conn) return { connected: false, qbo_env: config.qbo_env };
    return {
        connected: conn.refresh_token_expires_at.getTime() > Date.now() && realm_allowed(conn.realm_id),
        qbo_env: config.qbo_env,
        realm_id: conn.realm_id,
        connected_at: conn.connected_at,
        access_token_expires_at: conn.access_token_expires_at,
        refresh_token_expires_at: conn.refresh_token_expires_at,
    };
}
