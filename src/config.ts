function required(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
}

function optional_int(key: string, default_val: number): number {
    return parseInt(process.env[key] ?? String(default_val), 10);
}

function qbo_env(): "sandbox" | "production" {
    const val = process.env["QBO_ENV"] ?? "sandbox";
    if (val !== "sandbox" && val !== "production") throw new Error(`QBO_ENV must be sandbox or production, got ${val}`);
    return val;
}

export const config = {
    mongo_uri: required("MONGODB_URI"),
    mongo_db_name: required("MONGODB_DB_NAME"),
    sync_state_file: process.env["SYNC_STATE_FILE"] ?? "./sync_state.json",

    // sandbox -> sandbox-quickbooks.api.intuit.com with the Intuit app's development
    // keys; production -> quickbooks.api.intuit.com with its production keys. Dev
    // deployments run against a sandbox company, never a mock.
    qbo_env: qbo_env(),
    qbo_client_id: required("QBO_CLIENT_ID"),
    qbo_client_secret: required("QBO_CLIENT_SECRET"),
    // Must exactly match a redirect URI registered on the Intuit app. This is the
    // public zetrick-api callback, which forwards to our loopback API server.
    qbo_redirect_uri: required("QBO_REDIRECT_URI"),
    // When set, the OAuth callback refuses any other company and the sync refuses to
    // run against a stored token for a different realm. Keeps a sandbox deployment
    // from ever being connected to (and writing into) the real books, and vice versa.
    qbo_expected_realm_id: process.env["QBO_EXPECTED_REALM_ID"] ?? "",
    qbo_token_file: process.env["QBO_TOKEN_FILE"] ?? "./qbo_tokens.json",
    qbo_minor_version: process.env["QBO_MINOR_VERSION"] ?? "75",
    // QBO allows 500 requests/min per realm; stay under it with headroom.
    qbo_rate_limit_max_requests: optional_int("QBO_RATE_LIMIT_MAX_REQUESTS", 400),
    qbo_rate_limit_window_ms: optional_int("QBO_RATE_LIMIT_WINDOW_MS", 60 * 1000),

    // Keys the HMAC over each vendor's synced fields (see vendor_hash). A plain hash
    // would be brute-forceable back to the TIN, and Uber clients can read the mapping
    // collection, so it must be keyed. Changing it forces one re-push of every vendor.
    sync_hash_key: required("SYNC_HASH_KEY"),

    // Base tick of the single sequential loop that runs every feature's sync pass.
    sync_interval_ms: optional_int("SYNC_INTERVAL_MS", 60000),

    // Loopback-only API server that zetrick-api forwards /quickbooks/* to.
    api_server_port: optional_int("API_SERVER_PORT", 3002),

    // Each feature's cleanup pass (for vendors: stale mappings, hard-deleted subcs,
    // retry of permanent failures) runs once per window opening, in the server's LOCAL timezone. Day is
    // 0=Sunday..6=Saturday or -1 for every day. The window must not cross midnight.
    mapping_cleanup_day: optional_int("MAPPING_CLEANUP_DAY", -1),
    mapping_cleanup_start_hour: optional_int("MAPPING_CLEANUP_START_HOUR", 8),
    mapping_cleanup_window_hours: optional_int("MAPPING_CLEANUP_WINDOW_HOURS", 1),

    // Email alerts (SendGrid) for floored cursors, permanent per-feature failures and
    // a dead QBO connection. Disabled unless both the API key and a recipient are set.
    sendgrid_api_key: process.env["SENDGRID_API_KEY"] ?? "",
    alert_email_to: process.env["ALERT_EMAIL_TO"] ?? "",
    alert_email_from: process.env["ALERT_EMAIL_FROM"] ?? "no-reply@zetrick.com",
    cursor_floor_alert_passes: optional_int("CURSOR_FLOOR_ALERT_PASSES", 10),
    cursor_floor_realert_hours: optional_int("CURSOR_FLOOR_REALERT_HOURS", 24),
};
