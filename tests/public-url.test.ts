import assert from "assert";
import { publicBaseUrl, DEV_PUBLIC_URL, PROD_PUBLIC_URL } from "../src/utils/publicUrl";

assert.strictEqual(publicBaseUrl({} as any), PROD_PUBLIC_URL);
assert.strictEqual(publicBaseUrl({ BOT_ENV: "prod" } as any), PROD_PUBLIC_URL);
assert.strictEqual(publicBaseUrl({ BOT_ENV: "dev" } as any), DEV_PUBLIC_URL);
assert.strictEqual(publicBaseUrl({ BOT_ENV: "DEV" } as any), DEV_PUBLIC_URL);
assert.strictEqual(publicBaseUrl({ BOT_ENV: "dev", PUBLIC_URL: "https://x.test/" } as any), "https://x.test");
assert.strictEqual(publicBaseUrl({ BOT_ENV: "dev", BASE_URL: "https://b.test", PUBLIC_URL: "https://x.test" } as any), "https://b.test");
console.log("✓ public url");
