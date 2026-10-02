import { get_sync_state, save_vendor_failure, type vendor_failure } from "../sync_state";
import { send_alert, realert_due } from "../alerts";

// A subc whose vendor QBO permanently rejected (validation, duplicate name). The
// cursor moves on, so this alert is the only signal a human gets.

// Record a permanent vendor failure and alert on it. Alerts when the failure is new
// or the error changed; otherwise throttled like the floor alerts.
export async function record_vendor_failure(
    subc_id: string,
    subc_label: string,
    hash: string,
    error: string
): Promise<void> {
    try {
        const prev = get_sync_state().vendors.failures[subc_id];
        const now = new Date();
        const changed = !prev || prev.error !== error;
        const cur: vendor_failure = {
            hash,
            error,
            first_failed: prev && !changed ? prev.first_failed : now,
            last_failed: now,
            last_alerted: changed ? null : (prev?.last_alerted ?? null),
        };
        save_vendor_failure(subc_id, cur);
        if (!realert_due(cur.last_alerted)) return;

        const body = [
            `QuickBooks rejected the vendor for subcontractor ${subc_label}.`,
            ``,
            `Error: ${error}`,
            `First failed: ${cur.first_failed.toISOString()}`,
            ``,
            `This will not retry until the subcontractor (or its owner) is edited in Uber,`,
            `or the next daily cleanup pass. Fix the data in Uber, or resolve the conflict in`,
            `QuickBooks (e.g. a customer/employee/vendor already using this display name).`,
        ].join("\n");
        if (await send_alert(`Vendor sync failed for ${subc_label}`, body)) {
            cur.last_alerted = new Date();
            save_vendor_failure(subc_id, cur);
        }
    } catch (err) {
        elog(`[alert] Vendor failure alert for ${subc_label} failed:`, err);
    }
}

export function clear_vendor_failure(subc_id: string): void {
    if (get_sync_state().vendors.failures[subc_id]) {
        ilog(`[alert] Cleared vendor failure for subc ${subc_id}`);
        save_vendor_failure(subc_id, null);
    }
}
