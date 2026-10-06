"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  githubHandleForIdentity,
  parseReleaseIdentities,
  previousReleaseTag,
} = require("../scripts/verify-release-contributors");

test("release contributor audit selects the newest tag below the package version", () => {
  assert.strictEqual(
    previousReleaseTag("0.16.0", ["v0.14.0", "v0.15.0", "v0.16.0", "not-a-release"]),
    "v0.15.0",
  );
});

test("release contributor audit maps noreply, direct-email, and co-author identities", () => {
  const records = [
    "134911580+Cobb04@users.noreply.github.com\x00ShannonC\x00feature\x1e",
    "rullerzhou@gmail.com\x00rullerzhou-afk\x00merge\n\nCo-authored-by: Zamaniego <luis@aumentra.com>\x1e",
  ].join("");
  const identities = parseReleaseIdentities(records);
  assert.deepStrictEqual(
    identities.map((identity) => githubHandleForIdentity(identity.name, identity.email)),
    ["Cobb04", null, "Zamaniego"],
  );
});

test("unknown direct-email authors cannot silently bypass contributor credit", () => {
  assert.strictEqual(githubHandleForIdentity("New Person", "new@example.com"), undefined);
});

test("v1.1 contributor email identities map to their reviewed pull request authors", () => {
  const identities = [
    ["TalexDreamSoul", "TalexDreamSoul@Gmail.com"],
    ["FuZoe", "fxq4533@163.com"],
    ["undefined-moe", "i@undefined.moe"],
    ["pu-1205", "a1-6@1-6deMacBook-Air.local"],
    ["Tsdsj", "fucdd1946523@163.com"],
    ["mantertius", "mpat@ic.ufal.br"],
    ["Free-LZJ", "252015170@qq.com"],
    ["Free-LZJ", "zejian.li@exe.com"],
    ["PeterShanxin", "shanxin@u.nus.edu"],
    ["easyhak", "zhzhk17@gmail.com"],
    ["jlimcode", "jason.lim@decagon.ai"],
    ["xfurqan0", "yldzfurkann0@gmail.com"],
    ["brantshin", "shiji.shi@taobao.com"],
    ["VonSdite", "vonsdite@gmail.com"],
  ];
  for (const [handle, email] of identities) {
    assert.strictEqual(githubHandleForIdentity(handle, email), handle);
  }
});
