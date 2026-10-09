#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");

const ROOT = path.resolve(__dirname, "..");
const TEMPLATE_DIR = path.join(ROOT, ".github", "ISSUE_TEMPLATE");

const PAIRS = [
  {
    english: "bug-report.yml",
    chinese: "bug-report-zh.yml",
    title: "[Bug] ",
  },
  {
    english: "feature-request.yml",
    chinese: "feature-request-zh.yml",
    title: "[Feature] ",
  },
  {
    english: "integration-issue.yml",
    chinese: "integration-issue-zh.yml",
    title: "[Integration] ",
  },
];

function loadTemplate(filename) {
  const source = fs.readFileSync(path.join(TEMPLATE_DIR, filename), "utf8");
  const parsed = yaml.load(source);
  assert.ok(parsed && typeof parsed === "object", `${filename} must parse to an object`);
  return parsed;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function optionShape(option) {
  if (typeof option === "string") return { type: "string" };
  return {
    type: "object",
    hasLabel: hasOwn(option, "label"),
    required: Boolean(option && option.required),
  };
}

function fieldShape(field) {
  const attributes = field.attributes || {};
  return {
    type: field.type,
    id: field.id ?? null,
    validations: field.validations || {},
    hasLabel: hasOwn(attributes, "label"),
    hasDescription: hasOwn(attributes, "description"),
    hasPlaceholder: hasOwn(attributes, "placeholder"),
    hasValue: hasOwn(attributes, "value"),
    multiple: hasOwn(attributes, "multiple")
      ? Boolean(attributes.multiple)
      : null,
    render: attributes.render ?? null,
    options: Array.isArray(attributes.options)
      ? attributes.options.map(optionShape)
      : null,
  };
}

function templateShape(template) {
  return {
    title: template.title ?? null,
    labels: template.labels || [],
    assignees: template.assignees || [],
    body: (template.body || []).map(fieldShape),
  };
}

test("bilingual issue-form names are unique", () => {
  const names = PAIRS.flatMap(({ english, chinese }) => [
    loadTemplate(english).name,
    loadTemplate(chinese).name,
  ]);
  assert.equal(new Set(names).size, names.length);
});

for (const pair of PAIRS) {
  test(`${pair.english} and ${pair.chinese} keep the same structure`, () => {
    const english = loadTemplate(pair.english);
    const chinese = loadTemplate(pair.chinese);

    assert.equal(english.title, pair.title);
    assert.equal(chinese.title, pair.title);
    assert.deepEqual(templateShape(chinese), templateShape(english));
  });
}
