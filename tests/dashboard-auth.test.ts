process.env.DASHBOARD_PASSWORD = "correct horse battery";
import assert from "assert";
import type { IncomingMessage } from "http";

(async () => {
  const a = await import("../src/utils/dashboardAuth");
  const m = await import("../src/utils/channelMask");
  const req = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: "1.2.3.4" } }) as unknown as IncomingMessage;

  // password
  assert.ok(a.checkPassword("correct horse battery"));
  assert.ok(!a.checkPassword("correct horse batterx"));
  assert.ok(!a.checkPassword(""));

  // cookie session: valid for ~180 days, forged / tampered / expired are rejected
  const t = a.makeSessionToken();
  const left = a.sessionRemainingMs(t);
  assert.ok(left > 179 * 86400e3 && left <= 180 * 86400e3, "lasts about 180 days");
  assert.strictEqual(a.sessionRemainingMs(undefined), 0);
  assert.strictEqual(a.sessionRemainingMs("garbage"), 0);
  assert.strictEqual(a.sessionRemainingMs(`${Date.now() + 1e9}.${t.split(".")[1]}`), 0, "expiry cannot be changed");
  assert.strictEqual(a.sessionRemainingMs(a.makeSessionToken(Date.now() - 181 * 86400e3)), 0, "expired");
  const cookie = a.sessionCookie(t, true);
  assert.ok(/HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie) && /Max-Age=15552000/.test(cookie));

  // request auth: cookie, bearer, neither; a session past half its life is renewed
  assert.ok(a.authenticate(req({ cookie: `${a.COOKIE_NAME}=${encodeURIComponent(t)}` })).ok);
  assert.strictEqual(a.authenticate(req({ cookie: `${a.COOKIE_NAME}=${encodeURIComponent(t)}` })).renew, undefined, "fresh: no renewal");
  const old = a.makeSessionToken(Date.now() - 100 * 86400e3);
  const renewed = a.authenticate(req({ cookie: `x=1; ${a.COOKIE_NAME}=${encodeURIComponent(old)}` }));
  assert.ok(renewed.ok && /dash_session=/.test(renewed.renew || ""), "old session is renewed");
  assert.ok(a.authenticate(req({ authorization: "Bearer correct horse battery" })).ok);
  assert.ok(!a.authenticate(req({ authorization: "Bearer nope" })).ok);
  assert.ok(!a.authenticate(req({})).ok);

  // brute force: 5 wrong passwords block the address
  const ip = "9.9.9.9";
  for (let i = 0; i < 5; i++) { assert.ok(!a.loginBlocked(ip)); a.recordLoginFailure(ip); }
  assert.ok(a.loginBlocked(ip));
  assert.ok(!a.loginBlocked(ip, Date.now() + 16 * 60e3), "unblocked after 15 minutes");
  a.clearLoginFailures(ip);
  assert.ok(!a.loginBlocked(ip));

  // machine-to-machine routes cannot carry a cookie; everything else needs the login
  assert.ok(a.isMachineRoute("GET", "/api/longvideo/bundle/lv-abc123"), "cloud renderer downloads the bundle");
  assert.ok(a.isMachineRoute("POST", "/api/longvideo/progress"), "cloud renderer reports progress");
  assert.ok(a.isMachineRoute("POST", "/api/inject-reels"));
  assert.ok(a.isMachineRoute("GET", "/api/dm/webhook") && a.isMachineRoute("POST", "/api/dm/webhook"), "Meta webhook");
  assert.ok(!a.isMachineRoute("POST", "/api/longvideo/bundle/lv-abc123"), "bundle is GET only");
  assert.ok(!a.isMachineRoute("GET", "/api/longvideo/progress"));
  for (const p of ["/api/channels", "/api/dashboard", "/api/longvideo/start", "/api/longvideo/job", "/api/channels/save", "/api/video-preview"]) {
    assert.ok(!a.isMachineRoute("GET", p) && !a.isMachineRoute("POST", p), `${p} needs the login`);
  }

  // redirect target stays on this site
  assert.strictEqual(a.safeNext("/dashboard?x=1"), "/dashboard?x=1");
  assert.strictEqual(a.safeNext("//evil.com"), "/");
  assert.strictEqual(a.safeNext("https://evil.com"), "/");
  assert.strictEqual(a.safeNext("/\\evil.com"), "/");
  assert.strictEqual(a.safeNext(null), "/");

  // secrets never reach the browser
  const stored = {
    key: "codeorcap", brandName: "CodeOrCap", handle: "@c",
    instagramAccessToken: "IGAAtokentokentokentoken1234", instagramPassword: "hunter2hunter2", instagramSessionId: "sess%3Aabcdefghijkl9999",
    youtubeRefreshToken: "1//0refreshrefreshrefresh7777", youtubeClientSecret: "GOCSPX-secretsecret5555", facebookAccessToken: "EAAfbfbfbfbfbfbfb8888",
    instagramAccounts: [{ name: "a", igUserId: "111", accessToken: "IGAAaccount1tokentoken0001" }, { name: "b", igUserId: "222", accessToken: "IGAAaccount2tokentoken0002" }],
    youtubeChannels: [{ name: "CodeOrCap", refreshToken: "1//0yt1yt1yt1yt1yt1yt1yt1" }, { name: "CodeOrCap", refreshToken: "1//0yt2yt2yt2yt2yt2yt2yt2" }],
  };
  const masked = m.maskChannel(stored);
  const dump = JSON.stringify(masked);
  for (const secret of ["IGAAtokentoken", "hunter2", "abcdefghijkl", "refreshrefresh", "secretsecret", "fbfbfb", "account1token", "account2token", "yt1yt1", "yt2yt2"]) {
    assert.ok(!dump.includes(secret), `leaked ${secret}`);
  }
  assert.strictEqual(masked.brandName, "CodeOrCap");
  assert.ok(masked.instagramAccessToken!.startsWith(m.MASK) && masked.instagramAccessToken!.endsWith("1234"));
  assert.strictEqual(masked.instagramPassword, m.MASK, "short secrets show no characters");

  // saving the masked form back keeps the stored secrets; a newly typed secret replaces them
  const edited = { ...masked, brandName: "CodeOrCap 2", instagramAccessToken: "NEWTOKENNEWTOKEN" };
  const restored = m.restoreMasked(edited, stored);
  assert.strictEqual(restored.brandName, "CodeOrCap 2");
  assert.strictEqual(restored.instagramAccessToken, "NEWTOKENNEWTOKEN", "typed value wins");
  assert.strictEqual(restored.instagramPassword, stored.instagramPassword);
  assert.strictEqual(restored.youtubeClientSecret, stored.youtubeClientSecret);
  assert.deepStrictEqual(restored.instagramAccounts.map((x: any) => x.accessToken), stored.instagramAccounts.map((x) => x.accessToken));
  assert.deepStrictEqual(restored.youtubeChannels.map((x: any) => x.refreshToken), stored.youtubeChannels.map((x) => x.refreshToken), "same-name channels matched by position");
  // reordered accounts still match by igUserId
  const swapped = { ...masked, instagramAccounts: [masked.instagramAccounts![1], masked.instagramAccounts![0]] };
  assert.deepStrictEqual(m.restoreMasked(swapped, stored).instagramAccounts.map((x: any) => x.accessToken), [stored.instagramAccounts[1].accessToken, stored.instagramAccounts[0].accessToken]);

  console.log("✓ dashboard auth");
})().catch((e) => { console.error(e); process.exit(1); });
