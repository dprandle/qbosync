import { config } from "../config";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sliding-window rate limiter (same as qbtsync's). QBO throttles per realm (500
// requests/min) and answers 429 past that; we self-throttle below the ceiling.
// acquire() blocks the caller until a slot frees up rather than dropping the request.
export class sliding_window_rate_limiter {
    private hits: number[] = [];

    constructor(
        private readonly max_requests: number,
        private readonly window_ms: number
    ) {}

    async acquire(): Promise<void> {
        for (;;) {
            const now = Date.now();
            const cutoff = now - this.window_ms;
            while (this.hits.length > 0 && this.hits[0] <= cutoff) {
                this.hits.shift();
            }
            if (this.hits.length < this.max_requests) {
                this.hits.push(now);
                return;
            }
            const wait_ms = this.hits[0] + this.window_ms - now + 1;
            wlog(`[qbo-rate-limit] At ${this.max_requests} req/${this.window_ms}ms cap — pausing ${wait_ms}ms`);
            await sleep(wait_ms);
        }
    }
}

export const qbo_rate_limiter = new sliding_window_rate_limiter(
    config.qbo_rate_limit_max_requests,
    config.qbo_rate_limit_window_ms
);
