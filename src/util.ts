import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function ask_yes_no(question: string) {
    const rl = readline.createInterface({ input, output });

    while (true) {
        const answer = (await rl.question(`${question} (y/n): `)).trim().toLowerCase();

        if (answer === "y" || answer === "yes") {
            rl.close();
            return true;
        }

        if (answer === "n" || answer === "no") {
            rl.close();
            return false;
        }

        ilog("Please enter y/yes or n/no.");
    }
}

// Pick one of `options` by number, or 0 for none. Returns the index or -1.
export async function ask_choice(question: string, options: string[]): Promise<number> {
    const rl = readline.createInterface({ input, output });
    ilog(question);
    options.forEach((o, i) => ilog(`  ${i + 1}) ${o}`));
    ilog(`  0) none of these`);
    while (true) {
        const n = parseInt((await rl.question(`Choice (0-${options.length}): `)).trim(), 10);
        if (Number.isInteger(n) && n >= 0 && n <= options.length) {
            rl.close();
            return n - 1;
        }
        ilog("Please enter one of the listed numbers.");
    }
}
