import dotenv from "dotenv";

// Global log aliases. This runs as a systemd service, so stdout/stderr are already
// captured (with timestamps and per-unit metadata) by the journal — `journalctl -u
// qbosync`. We therefore log straight to the console rather than also teeing to a
// per-day file: the journal is the single source of truth, with its own rotation.
// warn/error go to stderr (journald tags them at a higher priority); the rest stdout.
declare global {
    var ilog: any;
    var dlog: any;
    var wlog: any;
    var elog: any;
    var asrt: any;
}

globalThis.ilog = console.log;
globalThis.dlog = console.debug;
globalThis.wlog = console.warn;
globalThis.elog = console.error;
globalThis.asrt = console.assert;

dotenv.config();
