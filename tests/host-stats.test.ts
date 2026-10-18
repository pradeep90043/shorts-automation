import assert from "assert";
import { cpuLimitOf, describeHost, hostSnapshot, parsePressure } from "../src/utils/hostStats";

assert.deepStrictEqual(parsePressure("some avg10=12.34 avg60=5.00 avg300=1.00 total=123\nfull avg10=3.10 avg60=1.00 avg300=0.50 total=9"), { some: 12.34, full: 3.1 });
assert.deepStrictEqual(parsePressure(""), {});
assert.strictEqual(cpuLimitOf("50000 100000"), 0.5);
assert.strictEqual(cpuLimitOf("200000 100000"), 2);
assert.strictEqual(cpuLimitOf("max 100000"), null);
assert.strictEqual(cpuLimitOf(""), null);

const s = hostSnapshot(); // works anywhere: unreadable counters are simply absent
assert.ok(s.cpus >= 1 && typeof describeHost(s) === "string");
console.log("✓ host stats");
