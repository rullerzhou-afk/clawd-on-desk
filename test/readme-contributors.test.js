"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const TABLE_READMES = ["README.md", "README.ko-KR.md", "README.ja-JP.md", "README.es.md"];
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
  "Zamaniego",
];

function loadSettingsContributors() {
  const source = fs.readFileSync(path.join(ROOT, "src", "settings-i18n.js"), "utf8");
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "settings-i18n.js" });
  return Array.from(context.ClawdSettingsI18n.CONTRIBUTORS);
}

function extractContributorLogins(markdown, filename) {
  const section = extractContributorSection(markdown, filename);
  const linked = [...section.matchAll(/href="https:\/\/github\.com\/([^"/]+)"/g)].map((match) => match[1]);
  // A contributor whose GitHub account no longer resolves is credited as plain text
  // rather than a link and avatar that both 404. Those entries still belong in the
  // list, so collect them from the markup left over once every link is removed.
  const unlinkedMarkup = section.replace(/<a\s[^>]*>[\s\S]*?<\/a>/g, "");
  const unlinked = [...unlinkedMarkup.matchAll(/<sub>([^<]+)<\/sub>/g)].map((match) => match[1].trim());
  return [...linked, ...unlinked];
}

function extractContributorTable(markdown, filename) {
  const tables = [...markdown.matchAll(/<table>[\s\S]*?<\/table>/g)]
    .map((match) => match[0])
    .map((table) => ({
      table,
      cellCount: countCells(table),
      githubAvatarCount: (table.match(/https:\/\/github\.com\/[^"\s]+\.png/g) || [])
        .length,
    }))
    .filter((candidate) => candidate.githubAvatarCount > 0)
    .sort((left, right) => right.cellCount - left.cellCount);
  assert.ok(tables.length > 0, `${filename} should contain a contributors table`);
  return tables[0].table;
}

function getRows(table) {
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
}

function countCells(row) {
  return (row.match(/<td\s/g) || []).length;
}

function getContributorShape(filename) {
  const markdown = fs.readFileSync(path.join(ROOT, filename), "utf8");
  const rows = getRows(extractContributorTable(markdown, filename));
  const cellCounts = rows.map(countCells);
  const totalCells = cellCounts.reduce((sum, count) => sum + count, 0);

  assert.ok(rows.length >= 2, `${filename} should have at least two contributor rows`);
  assert.ok(totalCells > 0, `${filename} should contain contributor cells`);

  for (const [index, count] of cellCounts.slice(0, -1).entries()) {
    assert.strictEqual(count, 7, `${filename} row ${index + 1} should be full`);
  }

  const finalRowCount = cellCounts[cellCounts.length - 1];
  assert.ok(
    finalRowCount >= 1 && finalRowCount <= 7,
    `${filename} final row should contain between 1 and 7 contributors`,
  );

  return cellCounts;
}

function extractContributorSection(markdown, filename) {
  const firstContributor = markdown.indexOf("https://github.com/PixelCookie-zyf");
  assert.notStrictEqual(firstContributor, -1, `${filename} should list contributors`);

  const start = markdown.lastIndexOf("### ", firstContributor);
  assert.notStrictEqual(start, -1, `${filename} should have a contributor heading`);

  const end = markdown.indexOf("\n## ", firstContributor);
  return markdown.slice(start, end === -1 ? markdown.length : end);
}

test("table-based README contributor grids are filled consistently", () => {
  const [baselineFile, ...localizedFiles] = TABLE_READMES;
  const baselineShape = getContributorShape(baselineFile);

  for (const filename of localizedFiles) {
    assert.deepStrictEqual(
      getContributorShape(filename),
      baselineShape,
      `${filename} should match ${baselineFile}'s contributor row shape`,
    );
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

test("README contributor sections include verified GitHub contributors", () => {
  for (const filename of ALL_READMES) {
    const markdown = fs.readFileSync(path.join(ROOT, filename), "utf8");

    for (const login of VERIFIED_GITHUB_CONTRIBUTORS) {
      assert.ok(
        markdown.includes(`https://github.com/${login}`),
        `${filename} should include ${login}`,
      );
    }
  }
});

test("all README contributor lists exactly match Settings About", () => {
  const expected = loadSettingsContributors();
  assert.strictEqual(new Set(expected).size, expected.length, "Settings contributors should not contain duplicates");

  for (const filename of ALL_READMES) {
    const markdown = fs.readFileSync(path.join(ROOT, filename), "utf8");
    const actual = extractContributorLogins(markdown, filename);
    assert.strictEqual(new Set(actual).size, actual.length, `${filename} should not contain duplicate contributors`);
    assert.deepStrictEqual(actual.slice().sort(), expected.slice().sort(), `${filename} contributors should match Settings About`);
  }
});
