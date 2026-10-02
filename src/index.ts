import "./global_setup";
import { config } from "./config";
import mongo from "./db";
import {
    reset_sync_state,
    reload_sync_state,
    ensure_state_file_writable,
    cleanup_due,
    save_cleanup_state,
} from "./sync_state";
import { qbo_client } from "./qbo/client";
import { start_api_server } from "./api_server";
import { update_vendors_from_subcs } from "./vendors/sync";
import { run_vendor_cleanup } from "./vendors/cleanup";

const do_reset = process.argv.includes("--reset");

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// A feature with background work. `ready` gates its passes (e.g. vendors wait for
// their one-time bootstrap); the API server and other features run regardless.
// Add new features (expenses, ...) to FEATURES.
type feature = {
    name: string;
    ready: () => boolean;
    not_ready_msg: string;
    sync: (qbo: qbo_client) => Promise<void>;
    cleanup?: (qbo: qbo_client) => Promise<void>;
};

let vendors_bootstrapped = false;

const FEATURES: feature[] = [
    {
        name: "vendors",
        // `npm run bootstrap_vendors` is a separate process that sets this flag in the
        // state file, so re-read it from disk until it's set. Without the bootstrap
        // links every subc would look unlinked and get a duplicate vendor.
        ready: () => (vendors_bootstrapped ||= reload_sync_state().vendors.bootstrap_complete),
        not_ready_msg:
            "vendor bootstrap not complete - connect QuickBooks via /quickbooks/connect, then run `npm run bootstrap_vendors`",
        sync: update_vendors_from_subcs,
        cleanup: run_vendor_cleanup,
    },
];

// One sequential loop, as in qbtsync: each ready feature's pass, then cleanups when
// their window opens. Serializing everything means cleanup never races a create over
// the mapping table, and all features share the one QBO rate limiter in order.
async function run_sync_loop(qbo: qbo_client): Promise<void> {
    ilog(`[sync] Starting sync loop (tick: ${config.sync_interval_ms}ms)`);
    const was_ready = new Map<string, boolean>();
    while (true) {
        const ready = FEATURES.filter((f) => {
            const ok = f.ready();
            if (ok !== was_ready.get(f.name)) {
                if (ok) ilog(`[sync] ${f.name}: ready - syncing`);
                else wlog(`[sync] ${f.name}: idle - ${f.not_ready_msg}`);
                was_ready.set(f.name, ok);
            }
            return ok;
        });

        for (const f of ready) {
            try {
                await f.sync(qbo);
            } catch (err) {
                elog(`[${f.name}] Pass error:`, err);
            }
        }

        // last_run is stamped only on a clean completion, so an error retries on the
        // next tick still inside the window.
        if (cleanup_due(new Date())) {
            let ok = true;
            for (const f of ready) {
                if (!f.cleanup) continue;
                try {
                    await f.cleanup(qbo);
                } catch (err) {
                    ok = false;
                    elog(`[${f.name}] Cleanup error:`, err);
                }
            }
            if (ok) save_cleanup_state({ last_run: new Date() });
        }
        await sleep(config.sync_interval_ms);
    }
}

async function main(): Promise<void> {
    ensure_state_file_writable();

    if (do_reset) {
        reset_sync_state();
        process.exit(0);
    }

    ilog(
        `[startup] QBO_ENV=${config.qbo_env}${config.qbo_expected_realm_id ? ` realm ${config.qbo_expected_realm_id}` : ""}`
    );
    await mongo.connect();
    await mongo.ensure_indexes();

    try {
        const app = await start_api_server();

        let shutting_down = false;
        const shutdown = async (sig: string): Promise<void> => {
            if (shutting_down) return;
            shutting_down = true;
            ilog(`[shutdown] ${sig} received - closing API server and MongoDB connection`);
            const force = setTimeout(() => {
                elog("[shutdown] Clean shutdown timed out - forcing exit");
                process.exit(1);
            }, 10_000);
            force.unref();
            try {
                await app.close();
                await mongo.disconnect();
                ilog("[shutdown] Clean shutdown complete");
                process.exit(0);
            } catch (err) {
                elog("[shutdown] Error during shutdown:", err);
                process.exit(1);
            }
        };
        for (const sig of ["SIGINT", "SIGTERM"] as const) {
            process.on(sig, () => void shutdown(sig));
        }

        await run_sync_loop(new qbo_client());
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("Fatal error:", err);
    process.exit(1);
});
