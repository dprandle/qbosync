import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { config } from "./config";

const STATE_FILE = config.sync_state_file;

export type vendor_sync_state = {
    bootstrap_complete: boolean; // true once the one-time vendor<->subc match has run
    subc_last_synced: Date | null; // subcontractor last_update.on cursor
    // hresource last_update.on cursor. An owner's name/SSN/address/etc. edit only
    // bumps the hresource, but flows into every subc that pulls that field from its
    // owner, so owner edits need their own cursor.
    hres_last_synced: Date | null;
    failures: Record<string, vendor_failure>; // permanent failures, keyed by subc _id
};

export type cleanup_state = {
    last_run: Date | null; // wall-clock time the last cleanup pass completed
};

// Per-cursor floored-state tracking for alerting (see alerts.ts).
export type cursor_floor_state = {
    floor: Date;
    detail: string;
    floored_since: Date;
    consecutive: number;
    last_alerted: Date | null;
};

// A subc whose vendor create/update was rejected by QBO in a way retrying won't fix
// (validation error, duplicate name). Recorded instead of flooring the cursor so one
// bad subc can't wedge the loop. The delta pass retries it whenever the subc or its
// owner changes, and the cleanup pass retries every failure once per window (to pick
// up fixes made on the QBO side, like renaming a conflicting customer).
export type vendor_failure = {
    hash: string; // vendor_hash of the fields we tried to push
    error: string;
    first_failed: Date;
    last_failed: Date;
    last_alerted: Date | null;
};

export type sync_state = {
    vendors: vendor_sync_state;
    cleanup: cleanup_state;
    floor_alerts: Record<string, cursor_floor_state>;
};

const default_state: sync_state = {
    vendors: {
        bootstrap_complete: false,
        subc_last_synced: null,
        hres_last_synced: null,
        failures: {},
    },
    cleanup: {
        last_run: null,
    },
    floor_alerts: {},
};

function opt_date(v: any): Date | null {
    return v ? new Date(v) : null;
}

function parse_floor_alerts(raw: any): Record<string, cursor_floor_state> {
    const out: Record<string, cursor_floor_state> = {};
    for (const [name, v] of Object.entries(raw ?? {})) {
        const s = v as any;
        if (!s?.floor || !s?.floored_since) continue;
        out[name] = {
            floor: new Date(s.floor),
            detail: s.detail ?? "",
            floored_since: new Date(s.floored_since),
            consecutive: s.consecutive ?? 0,
            last_alerted: opt_date(s.last_alerted),
        };
    }
    return out;
}

function parse_failures(raw: any): Record<string, vendor_failure> {
    const out: Record<string, vendor_failure> = {};
    for (const [id, v] of Object.entries(raw ?? {})) {
        const s = v as any;
        if (!s?.first_failed) continue;
        out[id] = {
            hash: s.hash ?? "",
            error: s.error ?? "",
            first_failed: new Date(s.first_failed),
            last_failed: new Date(s.last_failed ?? s.first_failed),
            last_alerted: opt_date(s.last_alerted),
        };
    }
    return out;
}

function parse_dates(state: any): sync_state {
    return {
        vendors: {
            bootstrap_complete: state.vendors?.bootstrap_complete ?? false,
            subc_last_synced: opt_date(state.vendors?.subc_last_synced),
            hres_last_synced: opt_date(state.vendors?.hres_last_synced),
            failures: parse_failures(state.vendors?.failures),
        },
        cleanup: {
            last_run: opt_date(state.cleanup?.last_run),
        },
        floor_alerts: parse_floor_alerts(state.floor_alerts),
    };
}

// Single in-memory copy of the state, read from disk on first access and kept in
// sync with every save.
let cached_state: sync_state | null = null;

function read_from_disk(): sync_state {
    if (!existsSync(STATE_FILE)) {
        return structuredClone(default_state);
    }
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    return parse_dates(raw);
}

// Verify up front that the state file can be created and written, so a
// misconfigured SYNC_STATE_FILE fails at startup rather than on the first save.
export function ensure_state_file_writable(): void {
    mkdirSync(dirname(resolve(STATE_FILE)), { recursive: true });
    if (!existsSync(STATE_FILE)) {
        write_state(default_state);
        ilog(`[sync_state] Created fresh state file at ${resolve(STATE_FILE)}.`);
    } else {
        write_state(get_sync_state());
    }
}

// Drop the in-memory copy so the next read comes from disk. The service uses this
// while waiting for `npm run bootstrap_vendors` (a separate process) to set its flag.
export function reload_sync_state(): sync_state {
    cached_state = null;
    return get_sync_state();
}

export function get_sync_state(): sync_state {
    if (!cached_state) cached_state = read_from_disk();
    return cached_state;
}

function write_state(state: sync_state): void {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function save_vendor_state(update: Partial<vendor_sync_state>): void {
    const state = get_sync_state();
    state.vendors = { ...state.vendors, ...update };
    write_state(state);
}

export function save_cleanup_state(update: Partial<cleanup_state>): void {
    const state = get_sync_state();
    state.cleanup = { ...state.cleanup, ...update };
    write_state(state);
}

export function save_floor_alert_state(name: string, st: cursor_floor_state | null): void {
    const state = get_sync_state();
    if (st) state.floor_alerts[name] = st;
    else delete state.floor_alerts[name];
    write_state(state);
}

export function save_vendor_failure(subc_id: string, f: vendor_failure | null): void {
    const state = get_sync_state();
    const failures = state.vendors.failures;
    if (f) failures[subc_id] = f;
    else if (failures[subc_id]) delete failures[subc_id];
    else return;
    write_state(state);
}

// True when the cleanup pass should start now: inside the configured window
// (server-local day + hour range) and not already run since this window opened.
export function cleanup_due(now: Date): boolean {
    const day = config.mapping_cleanup_day;
    if (day >= 0 && now.getDay() !== day) return false;

    const start = config.mapping_cleanup_start_hour;
    const end = start + config.mapping_cleanup_window_hours;
    const hour = now.getHours();
    if (hour < start || hour >= end) return false;

    const window_open = new Date(now);
    window_open.setHours(start, 0, 0, 0);
    const last = get_sync_state().cleanup.last_run;
    if (last && last >= window_open) return false;

    return true;
}

// Tracks per-item sync progress so the cursor only advances past items that were
// actually resolved. `earliest_unresolved` floors the cursor at one ms before the
// earliest failed item, guaranteeing it gets re-fetched.
export const CURSOR_EPOCH = new Date(0);

export type cursor_progress = {
    latest_resolved: Date;
    earliest_unresolved: Date | null;
    earliest_unresolved_detail?: string;
};

export function mark_unresolved(progress: cursor_progress, at: Date, detail: string): void {
    if (!progress.earliest_unresolved || at < progress.earliest_unresolved) {
        progress.earliest_unresolved = at;
        progress.earliest_unresolved_detail = detail;
    }
}

export function safe_cursor(progress: cursor_progress, since: Date): Date {
    let cursor = progress.latest_resolved;
    if (progress.earliest_unresolved) {
        const cap = new Date(progress.earliest_unresolved.getTime() - 1);
        if (cap < cursor) cursor = cap;
    }
    return cursor < since ? since : cursor;
}

export function reset_sync_state(): void {
    cached_state = null;
    if (existsSync(STATE_FILE)) {
        unlinkSync(STATE_FILE);
        ilog("[sync_state] Sync state reset.");
    } else {
        ilog("[sync_state] No sync state file found; nothing to reset.");
    }
}
