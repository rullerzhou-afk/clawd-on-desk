"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const ALL_READMES = [
  "README.md",
  "README.zh-CN.md",
  "README.zh-TW.md",
  "README.ko-KR.md",
  "README.ja-JP.md",
  "README.es.md",
];

test("all other README variants expose Spanish navigation without a Spanish self-link", () => {
  for (const file of ALL_READMES.filter((name) => name !== "README.es.md")) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(source, /href="README\.es\.md"/, `${file} should link to README.es.md`);
  }
  const spanish = fs.readFileSync(path.join(ROOT, "README.es.md"), "utf8");
  assert.doesNotMatch(spanish, /href="README\.es\.md"/, "README.es.md should not link to itself");
});

const VERIFIED_GITHUB_CONTRIBUTORS = [
  "Bynlk",
  "zxypro1",
  "NeroAyase",
  "divergentD",
  "Ne9roni",
  "QingXB",
  "29206394",
  "Tsdsj",
  "godlockin",
  "zhaoxv210",
  "serenNan",
  "IatomicreactorI",
  "quantai1314",
  "Git-creat7",
  "undownding",
  "chrono-meta",
  "Yike-Ye",
  "xiaoshidefeng",
  "yanguibao1997",
  "JasonZH6600",
  "V1staz",
  "royhuang91",
  "Schlaflied",
  "KaiC5504",
  "jiaxuan1101",
  "kkirito16",
  "200780381",
  "Dxy2326",
  "lurui1997",
  "JesmonX",
  "chen86860",
  "LinYsssss",
  "He-wei-gui",
  "liugou27",
  "YOOGOMJA",
  "anupamme",
  "anthonyonazure",
  "weed33834",
  "arismarioneves",
  "wang4433",
  "shengmai-justin",
  "Zamaniego",
  "CheeseAgent",
  "RS-Nocsi",
  "Cobb04",
  "TalexDreamSoul",
  "FuZoe",
  "undefined-moe",
  "pu-1205",
  "Free-LZJ",
  "easyhak",
  "jlimcode",
  "xfurqan0",
  "brantshin",
  "mantertius",
  "VonSdite",
  "sunnyswag",
  "hanzhe-one",
  "52mzd",
  "gzx19990101",
  "ypjn",
  "jin-codes",
  "LetitiaChan",
  "sanzanazaman",
  "zero-or-one",
  "integrasoft-c",
  "yunho09",
  "tianxingjian2406",
  "Aminorsh",
  "daijx-ai",
  "XYZliang",
];

const MAINTAINERS_SVG = path.join("assets", "readme", "maintainers.svg");
const CONTRIBUTORS_SVG = path.join("assets", "readme", "contributors.svg");

function loadSettingsLists() {
  const source = fs.readFileSync(path.join(ROOT, "src", "settings-i18n.js"), "utf8");
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "settings-i18n.js" });
  return {
    maintainers: Array.from(context.ClawdSettingsI18n.MAINTAINERS),
    contributors: Array.from(context.ClawdSettingsI18n.CONTRIBUTORS),
  };
}

function svgLogins(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
  return [...source.matchAll(/data-login="([^"]+)"/g)].map((match) => match[1]);
}

function extractContributorSection(markdown, filename) {
  const image = markdown.indexOf('src="assets/readme/contributors.svg"');
  assert.notStrictEqual(image, -1, `${filename} should show the contributors image`);

  const start = markdown.lastIndexOf("### ", image);
  assert.notStrictEqual(start, -1, `${filename} should have a contributor heading`);

  const end = markdown.indexOf("\n## ", image);
  return markdown.slice(start, end === -1 ? markdown.length : end);
}

test("every README shows the generated maintainer and contributor images", () => {
  for (const filename of ALL_READMES) {
    const markdown = fs.readFileSync(path.join(ROOT, filename), "utf8");
    assert.match(markdown, /<img src="assets\/readme\/maintainers\.svg"/, `${filename} should show maintainers`);
    assert.match(markdown, /<img src="assets\/readme\/contributors\.svg"/, `${filename} should show contributors`);
  }
});

test("README contributor sections stay visible", () => {
  for (const filename of ALL_READMES) {
    const markdown = fs.readFileSync(path.join(ROOT, filename), "utf8");
    const section = extractContributorSection(markdown, filename);
    assert.ok(!section.includes("<details>"), `${filename} should not fold contributors`);
    assert.ok(!section.includes("<summary>"), `${filename} should not fold contributors`);
  }
});

test("contributor image includes verified GitHub contributors", () => {
  const logins = new Set(svgLogins(CONTRIBUTORS_SVG));
  for (const login of VERIFIED_GITHUB_CONTRIBUTORS) {
    assert.ok(logins.has(login), `contributors.svg should include ${login}`);
  }
});

test("README avatar images exactly match Settings About (run npm run generate:readme-contributors)", () => {
  const { maintainers, contributors } = loadSettingsLists();
  assert.strictEqual(new Set(contributors).size, contributors.length, "Settings contributors should not contain duplicates");
  assert.deepStrictEqual(svgLogins(MAINTAINERS_SVG), maintainers, "maintainers.svg should match Settings About");
  assert.deepStrictEqual(svgLogins(CONTRIBUTORS_SVG), contributors, "contributors.svg should match Settings About");
});
