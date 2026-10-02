import { hostname } from "os";
import { config } from "./config";
import { cursor_floor_state, cursor_progress, get_sync_state, save_floor_alert_state } from "./sync_state";

// Email alerts via SendGrid: send_alert for one-off alerts (lost QBO connection,
// per-feature failures like vendors/failures.ts), and track_cursor_floor for a cursor
// pinned on the same item for many passes (a transient failure that isn't clearing).
// None of these may throw into the sync loop.

const SENDGRID_SEND_EMAIL_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

function email_configured(): boolean {
    return Boolean(config.sendgrid_api_key && config.alert_email_to);
}

function auth_header(): string {
    const key = config.sendgrid_api_key;
    return key.startsWith("Bearer ") ? key : `Bearer ${key}`;
}

export function realert_due(last_alerted: Date | null): boolean {
    return !last_alerted || Date.now() - last_alerted.getTime() >= config.cursor_floor_realert_hours * 3_600_000;
}

// Returns true if an email actually went out.
export async function send_alert(subject: string, body: string): Promise<boolean> {
    if (!email_configured()) {
        wlog(`[alert] (email not configured) ${subject}`);
        return false;
    }
    const resp = await fetch(SENDGRID_SEND_EMAIL_ENDPOINT, {
        method: "POST",
        headers: { Authorization: auth_header(), "Content-Type": "application/json" },
        body: JSON.stringify({
            personalizations: [{ to: [{ email: config.alert_email_to }] }],
            from: { email: config.alert_email_from, name: "qbosync" },
            subject: `[qbosync ${config.qbo_env}] ${subject}`,
            content: [{ type: "text/plain", value: `Host: ${hostname()}\n\n${body}` }],
        }),
    });
    if (resp.status !== 202) {
        throw new Error(`SendGrid send failed (${resp.status}): ${await resp.text()}`);
    }
    return true;
}

// Called once per completed pass per cursor.
export async function track_cursor_floor(name: string, progress: cursor_progress): Promise<void> {
    try {
        const prev = get_sync_state().floor_alerts[name];
        const floor = progress.earliest_unresolved;
        if (!floor) {
            if (prev) {
                ilog(`[alert] Cursor "${name}" floor cleared after ${prev.consecutive} pass(es)`);
                save_floor_alert_state(name, null);
            }
            return;
        }

        const same_item = prev && prev.floor.getTime() === floor.getTime();
        const cur: cursor_floor_state = same_item
            ? { ...prev, consecutive: prev.consecutive + 1, detail: progress.earliest_unresolved_detail || prev.detail }
            : {
                  floor,
                  detail: progress.earliest_unresolved_detail ?? "",
                  floored_since: new Date(),
                  consecutive: 1,
                  last_alerted: null,
              };
        save_floor_alert_state(name, cur);

        if (cur.consecutive < config.cursor_floor_alert_passes || !realert_due(cur.last_alerted)) return;

        const body = [
            `Cursor "${name}" has been floored on the same item for ${cur.consecutive} consecutive passes.`,
            ``,
            `Floored since:  ${cur.floored_since.toISOString()}`,
            `Floor value:    ${cur.floor.toISOString()}`,
            `Blocking item:  ${cur.detail || "(unknown)"}`,
            ``,
            `Inspect with: journalctl -u qbosync | grep -E "Transient|Error"`,
        ].join("\n");
        if (await send_alert(`${name} cursor floored for ${cur.consecutive} passes`, body)) {
            cur.last_alerted = new Date();
            save_floor_alert_state(name, cur);
        }
    } catch (err) {
        elog(`[alert] Floored-cursor alert for "${name}" failed:`, err);
    }
}
