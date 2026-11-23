"use strict";

// Static guard for the animations in Clawd's OBJECT-channel SVGs.
//
// Chromium can only keep an SVG out of the main-thread repaint path when every
// animation in it stays on the compositor. The known requirements come from
// Chromium's compositor_animations.cc (146) and from the Electron trace review
// of the 39 Clawd assets (docs/reviews/awake-cpu/DECISION-r1-total-switch.md):
//
//   R1 keyframes-property          keyframes may only animate transform/opacity
//   R2 use-translation-transform   <use x= y=> must not also animate transform
//   R3 animated-use-target         a <use> target (or descendant) must be static
//   R4 smil-animation              no <animate>/<animateTransform>/<animateMotion>/<set>
//   R5 nested-svg                  no <svg> inside the root <svg>
//
// This module is intentionally dependency-light (only the runtime htmlparser2)
// and has no Electron dependency, so the same test runs on every platform.

const { parseDocument } = require("htmlparser2");

const RULES = Object.freeze({
  R1: Object.freeze({ id: "keyframes-property", hint: "Only animate transform or opacity inside @keyframes. Chromium does not composite the independent translate, rotate, or scale properties on SVG targets. filter/backdrop-filter stay disallowed by project policy (stricter than Chromium). For a color flash, stack two layers and animate only the top layer's opacity. Replace visibility with opacity plus steps()." }),
  R2: Object.freeze({ id: "use-translation-transform", hint: "Keep the animated <g> outside and put the offset on an inner static <g transform=\"translate(x,y)\">: outer animated <g> -> inner <g transform> -> content. Do not animate transform on a <use> that also carries x/y, whether x/y comes from attributes or CSS." }),
  R3: Object.freeze({ id: "animated-use-target", hint: "Move the animation onto the <use> element itself (then R2 applies) or inline-clone the referenced content instead of animating the definition." }),
  R4: Object.freeze({ id: "smil-animation", hint: "Replace SMIL with CSS @keyframes that only animate transform/opacity so the compositor can take over." }),
  R5: Object.freeze({ id: "nested-svg", hint: "Flatten the inner <svg> into a <g> with a transform so the root document owns a single animation tree." }),
});

// Chromium 146 compositor_animations.cc treats SVG targets with independent
// translate/rotate/scale as non-composited (kSVGTargetHasIndependentTransformProperty).
// filter/backdrop-filter are candidates in Chromium but deliberately excluded
// here as a project policy, so this allowlist is stricter than the browser.
const COMPOSITED_PROPERTIES = new Set(["transform", "opacity"]);
const KEYFRAME_METADATA_PROPERTIES = new Set(["animation-timing-function"]);
const COMPOSITION_PROPERTY = "animation-composition";
const TRANSFORM_PROPERTIES = new Set(["transform", "translate", "rotate", "scale"]);
const SMIL_TAGS = new Set(["animate", "animatetransform", "animatemotion", "set"]);
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const PROPERTY_ALIASES = new Map([
  ["-webkit-animation", "animation"],
  ["-webkit-animation-name", "animation-name"],
]);

const SHORTHAND_KEYWORDS = new Set([
  "infinite",
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
  "none",
  "forwards",
  "backwards",
  "both",
  "running",
  "paused",
  "linear",
  "ease",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "step-start",
  "step-end",
]);

const TIME_VALUE_RE = /^[+-]?(?:\d+|\d*\.\d+)(?:ms|s)$/i;
const NUMBER_RE = /^[+-]?(?:\d+|\d*\.\d+)$/;
const FUNCTION_TOKEN_RE = /^[A-Za-z_-][\w-]*\(/;
const COMPOUND_TOKEN_RE = /[A-Za-z_][\w-]*|\.[A-Za-z_][\w-]*|#[A-Za-z_][\w-]*/g;
const COMPOUND_RE = /^(?:[A-Za-z_][\w-]*|\.[A-Za-z_][\w-]*|#[A-Za-z_][\w-]*)+$/;

// At-rules whose block contains ordinary rules and/or nested at-rules. The
// condition itself is irrelevant to this static check, so recursing makes the
// audit stricter without needing to evaluate media features.
const NESTED_RULE_AT_RULES = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "scope",
  "document",
  "starting-style",
]);

function describeElement(element) {
  const className = element.classes.length ? `.${element.classes.join(".")}` : "";
  const id = element.id ? `#${element.id}` : "";
  return `${element.name}${id}${className}`;
}

function stripCssComments(css) {
  let out = "";
  let quote = "";

  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < css.length) {
          out += css[i + 1];
          i += 1;
        }
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    out += ch;
  }

  return out;
}

/** Split on a delimiter that is not inside parentheses or quotes. */
function splitTopLevel(value, delimiter) {
  const parts = [];
  let buffer = "";
  let depth = 0;
  let quote = "";

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      buffer += ch;
      if (ch === "\\") {
        i += 1;
        if (i < value.length) buffer += value[i];
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      buffer += ch;
    } else if (ch === "(") {
      depth += 1;
      buffer += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      buffer += ch;
    } else if (ch === delimiter && depth === 0) {
      parts.push(buffer);
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  parts.push(buffer);
  return parts;
}

/** Split a value into whitespace-separated tokens, keeping function calls whole. */
function splitTokens(value) {
  const tokens = [];
  let buffer = "";
  let depth = 0;
  let quote = "";

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      buffer += ch;
      if (ch === "\\") {
        i += 1;
        if (i < value.length) buffer += value[i];
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      buffer += ch;
    } else if (ch === "(") {
      depth += 1;
      buffer += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      buffer += ch;
    } else if (/\s/.test(ch) && depth === 0) {
      if (buffer) {
        tokens.push(buffer);
        buffer = "";
      }
    } else {
      buffer += ch;
    }
  }
  if (buffer) tokens.push(buffer);
  return tokens;
}

function parseDeclarations(block) {
  const declarations = [];
  for (const chunk of splitTopLevel(stripCssComments(block), ";")) {
    const colon = chunk.indexOf(":");
    if (colon < 0) continue;
    const rawProperty = chunk.slice(0, colon).trim().toLowerCase();
    const property = PROPERTY_ALIASES.get(rawProperty) || rawProperty;
    const value = chunk.slice(colon + 1)
      .replace(/\s*!\s*important\s*$/i, "")
      .trim();
    if (!property || !value) continue;
    declarations.push({ property, value });
  }
  return declarations;
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function animationNameFromShorthand(part) {
  for (const token of splitTokens(part)) {
    const lower = token.toLowerCase();
    if (TIME_VALUE_RE.test(lower)) continue;
    if (NUMBER_RE.test(lower)) continue;
    if (SHORTHAND_KEYWORDS.has(lower)) continue;
    if (FUNCTION_TOKEN_RE.test(token)) continue;
    if (lower.startsWith("!")) continue;
    if (lower === "") continue;
    return unquote(token);
  }
  return null;
}

function compositionNeedsMainThread(value) {
  return splitTopLevel(value, ",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .some((part) => part !== "replace");
}

function analyzeAnimationDeclaration(declaration) {
  const names = [];
  const unresolved = [];
  const value = declaration.value.trim();

  if (CSS_WIDE_KEYWORDS.has(value.toLowerCase())) {
    return { names, unresolved, unsupportedValue: value };
  }

  // A var() may expand into additional animation entries. Even when explicit
  // names are present, keep a note so the unseen part cannot pass silently.
  if (/var\(/i.test(value)) unresolved.push(value);

  if (declaration.property === "animation") {
    for (const part of splitTopLevel(value, ",")) {
      const name = animationNameFromShorthand(part);
      if (name) names.push(name);
    }
  } else if (declaration.property === "animation-name") {
    for (const part of splitTopLevel(value, ",")) {
      const name = unquote(part);
      if (!name || name.toLowerCase() === "none" || /var\(/i.test(name)) continue;
      names.push(name);
    }
  }

  return { names, unresolved, unsupportedValue: null };
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let quote = "";
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

function parseKeyframeProperties(block) {
  const properties = new Set();
  const compositionValues = [];

  let i = 0;
  while (i < block.length) {
    const open = block.indexOf("{", i);
    if (open < 0) break;
    const close = findMatchingBrace(block, open);
    for (const declaration of parseDeclarations(block.slice(open + 1, close))) {
      properties.add(declaration.property);
      if (declaration.property === COMPOSITION_PROPERTY) {
        compositionValues.push(declaration.value);
      }
    }
    i = close + 1;
  }
  return { properties, compositionValues };
}

function registerKeyframe(keyframes, name, parsed) {
  const existing = keyframes.get(name);
  if (existing) {
    // Duplicate @keyframes definitions (for example inside an ignored
    // @media block) are merged. Unioning properties is the conservative
    // choice: a later definition must not erase a real violation.
    for (const property of parsed.properties) existing.properties.add(property);
    for (const value of parsed.compositionValues) existing.compositionValues.add(value);
    return;
  }
  keyframes.set(name, {
    name,
    properties: new Set(parsed.properties),
    compositionValues: new Set(parsed.compositionValues),
  });
}

function containsBraceOutsideQuotes(text) {
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "{") return true;
  }
  return false;
}

function parseCss(cssText) {
  const css = stripCssComments(cssText);
  const rules = [];
  const keyframes = new Map();
  const unsupported = [];

  let i = 0;
  while (i < css.length) {
    while (i < css.length && /\s/.test(css[i])) i += 1;
    if (i >= css.length) break;

    if (css[i] === "@") {
      const ruleEnd = css.indexOf("{", i);
      const semicolonEnd = css.indexOf(";", i);
      if (ruleEnd < 0 || (semicolonEnd >= 0 && semicolonEnd < ruleEnd)) {
        i = semicolonEnd < 0 ? css.length : semicolonEnd + 1;
        continue;
      }
      const prelude = css.slice(i, ruleEnd).trim();
      const close = findMatchingBrace(css, ruleEnd);
      const block = css.slice(ruleEnd + 1, close);
      const keyframesMatch = prelude.match(/^@(?:-\w+-)?keyframes\s+(.+)$/i);
      if (keyframesMatch) {
        const name = unquote(keyframesMatch[1].trim());
        registerKeyframe(keyframes, name, parseKeyframeProperties(block));
      } else {
        const atName = (prelude.match(/^@([\w-]+)/) || [])[1];
        if (atName && NESTED_RULE_AT_RULES.has(atName.toLowerCase())) {
          const nested = parseCss(block);
          rules.push(...nested.rules);
          for (const [name, keyframe] of nested.keyframes) {
            registerKeyframe(keyframes, name, {
              properties: keyframe.properties,
              compositionValues: keyframe.compositionValues,
            });
          }
          unsupported.push(...nested.unsupported);
        }
      }
      i = close + 1;
      continue;
    }

    const open = css.indexOf("{", i);
    if (open < 0) break;
    const selectorText = css.slice(i, open).trim();
    const close = findMatchingBrace(css, open);
    const ruleBlock = css.slice(open + 1, close);

    if (containsBraceOutsideQuotes(ruleBlock)) {
      unsupported.push({
        type: "unsupported-nesting",
        selector: selectorText,
        reason: "CSS nesting is not modeled; this rule was skipped.",
        hint: "Flatten the nested rule or move the animation to a top-level rule.",
      });
      i = close + 1;
      continue;
    }

    const declarations = parseDeclarations(ruleBlock);
    const selectorParts = splitTopLevel(selectorText, ",");
    const subjects = [];

    for (const rawSelector of selectorParts) {
      const parsed = parseSelectorSubject(rawSelector);
      if (!parsed.ok) {
        unsupported.push({
          type: "unsupported-selector",
          selector: rawSelector.trim(),
          reason: parsed.reason,
          hint: "Rewrite the selector with a tag name, .class, #id, and descendant/child combinators only.",
        });
      } else {
        subjects.push(parsed.subject);
      }
    }

    // A rule we cannot fully understand is skipped rather than partially
    // applied; the gate treats any note as a failure so new selector syntax is
    // reviewed instead of silently escaping the check.
    if (subjects.length === selectorParts.length) {
      rules.push({ selector: selectorText, subjects, declarations });
    }
    i = close + 1;
  }

  return { rules, keyframes, unsupported };
}

/**
 * Only the last compound selector (the subject) is matched. Ancestor parts are
 * ignored on purpose: this may over-match, which makes the check stricter, but
 * it never hides an animation.
 */
function parseSelectorSubject(rawSelector) {
  const selector = rawSelector.trim().replace(/\s*>\s*/g, ">");
  if (!selector) return { ok: false, reason: "empty selector" };
  if (/[\[\]:+~*|\\]/.test(selector)) {
    return { ok: false, reason: "pseudo-class, attribute, sibling, or unsupported selector syntax" };
  }

  const parts = selector.split(/[>\s]+/).filter(Boolean);
  if (!parts.length || selector.endsWith(">") || selector.startsWith(">")) {
    return { ok: false, reason: "malformed combinator" };
  }
  const compound = parts[parts.length - 1];
  if (!COMPOUND_RE.test(compound)) {
    return { ok: false, reason: "unsupported compound selector" };
  }

  const subject = { tag: null, id: null, classes: [] };
  for (const token of compound.match(COMPOUND_TOKEN_RE) || []) {
    if (token.startsWith(".")) subject.classes.push(token.slice(1));
    else if (token.startsWith("#")) subject.id = token.slice(1);
    else subject.tag = token.toLowerCase();
  }
  return { ok: true, subject };
}

function matchesSubject(element, subject) {
  if (subject.tag && element.name !== subject.tag) return false;
  if (subject.id && element.id !== subject.id) return false;
  return subject.classes.every((className) => element.classes.includes(className));
}

function collectElements(document) {
  const elements = [];

  function visit(node) {
    if (!node) return;
    if (node.type === "tag") {
      const className = node.attribs && node.attribs.class ? node.attribs.class : "";
      elements.push({
        node,
        name: (node.name || "").toLowerCase(),
        id: node.attribs && node.attribs.id ? node.attribs.id : "",
        classes: className.split(/\s+/).filter(Boolean),
      });
      for (const child of node.children || []) visit(child);
    } else {
      for (const child of node.children || []) visit(child);
    }
  }

  for (const child of document.children || []) visit(child);
  return elements;
}

function collectStyleText(elements) {
  const chunks = [];

  // In xmlMode htmlparser2 represents <![CDATA[...]]> as a "cdata" node whose
  // text lives on a child. Inkscape and Illustrator commonly wrap <style>
  // contents this way, so collect text recursively instead of only looking at
  // direct text children.
  function collectText(node) {
    if (node.type === "text") {
      chunks.push(node.data);
      return;
    }
    for (const child of node.children || []) collectText(child);
  }

  for (const element of elements) {
    if (element.name !== "style") continue;
    collectText(element.node);
  }
  return chunks.join("\n");
}

function collectAnimationsByElement(elements, rules, keyframes, notes) {
  const byElement = new Map();
  const seenNotes = new Set();

  const add = (element, name) => {
    if (!name || !keyframes.has(name)) return;
    let names = byElement.get(element);
    if (!names) {
      names = new Set();
      byElement.set(element, names);
    }
    names.add(name);
  };

  const addNote = (element, selector, note) => {
    const key = `${note.type}\u0000${selector || ""}\u0000${describeElement(element)}\u0000${note.value || ""}`;
    if (seenNotes.has(key)) return;
    seenNotes.add(key);
    notes.push({
      ...note,
      selector: selector || null,
      element: describeElement(element),
    });
  };

  const applyDeclaration = (element, declaration, selector) => {
    if (declaration.property !== "animation" && declaration.property !== "animation-name") return;

    const { names, unresolved, unsupportedValue } = analyzeAnimationDeclaration(declaration);
    for (const name of names) add(element, name);

    if (unsupportedValue) {
      addNote(element, selector, {
        type: "unsupported-animation-value",
        value: unsupportedValue,
        reason: "CSS-wide keywords may inherit an animation from an ancestor; inheritance is not modeled.",
        hint: "Use an explicit animation or animation-name list on the element.",
      });
    }
    for (const value of unresolved) {
      addNote(element, selector, {
        type: "unresolved-animation-name",
        value,
        reason: "The animation name is a var() expression, so the audit cannot resolve it.",
        hint: "Use an explicit animation name, or extend the audit if this syntax is intended.",
      });
    }
  };

  for (const rule of rules) {
    const animated = rule.declarations.filter((declaration) => (
      declaration.property === "animation" || declaration.property === "animation-name"
    ));
    if (!animated.length) continue;

    for (const element of elements) {
      if (!rule.subjects.some((subject) => matchesSubject(element, subject))) continue;
      for (const declaration of animated) applyDeclaration(element, declaration, rule.selector);
    }
  }

  for (const element of elements) {
    const style = element.node.attribs && element.node.attribs.style;
    if (!style) continue;
    for (const declaration of parseDeclarations(style)) {
      applyDeclaration(element, declaration, null);
    }
  }

  return byElement;
}

function addKeyframeViolations(keyframes, animationsByElement, violations) {
  const usersByAnimation = new Map();
  for (const [element, names] of animationsByElement) {
    for (const name of names) {
      if (!usersByAnimation.has(name)) usersByAnimation.set(name, []);
      usersByAnimation.get(name).push(describeElement(element));
    }
  }

  for (const [name, keyframe] of keyframes) {
    for (const property of keyframe.properties) {
      if (KEYFRAME_METADATA_PROPERTIES.has(property)) continue;
      if (property === COMPOSITION_PROPERTY) continue;
      if (COMPOSITED_PROPERTIES.has(property)) continue;
      const users = usersByAnimation.get(name) || [];
      violations.push({
        rule: "R1",
        id: RULES.R1.id,
        element: users.length ? users.join(", ") : "(unused @keyframes)",
        animation: name,
        property,
        message: `@keyframes "${name}" animates "${property}". ${RULES.R1.hint}`,
      });
    }

    if ([...keyframe.compositionValues].some(compositionNeedsMainThread)) {
      const users = usersByAnimation.get(name) || [];
      violations.push({
        rule: "R1",
        id: RULES.R1.id,
        element: users.length ? users.join(", ") : "(unused @keyframes)",
        animation: name,
        property: COMPOSITION_PROPERTY,
        message: `@keyframes "${name}" uses a non-replace ${COMPOSITION_PROPERTY}; Chromium keeps that effect on the main thread. Use replace or omit the property.`,
      });
    }
  }
}

function addElementCompositionViolations(elements, rules, violations) {
  const seen = new Set();

  const add = (element, selector, declaration) => {
    if (!compositionNeedsMainThread(declaration.value)) return;
    const key = `${describeElement(element)}\u0000${declaration.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    const source = selector ? `Rule "${selector}"` : "Inline style";
    violations.push({
      rule: "R1",
      id: RULES.R1.id,
      element: describeElement(element),
      animation: "(element declaration)",
      property: COMPOSITION_PROPERTY,
      message: `${source} sets a non-replace ${COMPOSITION_PROPERTY}; Chromium keeps that effect on the main thread. Use replace or omit the property.`,
    });
  };

  for (const rule of rules) {
    const compositions = rule.declarations.filter((declaration) => (
      declaration.property === COMPOSITION_PROPERTY
    ));
    if (!compositions.length) continue;
    for (const element of elements) {
      if (!rule.subjects.some((subject) => matchesSubject(element, subject))) continue;
      for (const declaration of compositions) add(element, rule.selector, declaration);
    }
  }

  for (const element of elements) {
    const style = element.node.attribs && element.node.attribs.style;
    if (!style) continue;
    for (const declaration of parseDeclarations(style)) {
      if (declaration.property === COMPOSITION_PROPERTY) add(element, null, declaration);
    }
  }
}

function offsetValueIsNonZero(value) {
  const text = String(value).trim();
  if (!text) return false;
  const numeric = Number.parseFloat(text);
  // Non-numeric but present values (3%, calc(...), var(...)) are treated as
  // non-zero on purpose: conservative, never hides a real AdditionalTranslation.
  return !Number.isFinite(numeric) || numeric !== 0;
}

function collectUseOffsets(element, rules) {
  const offsets = [];
  const attribs = element.node.attribs || {};
  for (const axis of ["x", "y"]) {
    if (attribs[axis] !== undefined) offsets.push(attribs[axis]);
  }

  const inline = attribs.style;
  if (inline) {
    for (const declaration of parseDeclarations(inline)) {
      if (declaration.property === "x" || declaration.property === "y") {
        offsets.push(declaration.value);
      }
    }
  }

  for (const rule of rules) {
    if (!rule.subjects.some((subject) => matchesSubject(element, subject))) continue;
    for (const declaration of rule.declarations) {
      if (declaration.property === "x" || declaration.property === "y") {
        offsets.push(declaration.value);
      }
    }
  }

  return offsets;
}

function addUseTranslationViolations(elements, rules, animationsByElement, keyframes, violations) {
  for (const element of elements) {
    if (element.name !== "use") continue;
    if (!collectUseOffsets(element, rules).some(offsetValueIsNonZero)) continue;

    const names = animationsByElement.get(element);
    if (!names) continue;
    for (const name of names) {
      const keyframe = keyframes.get(name);
      for (const property of keyframe.properties) {
        if (!TRANSFORM_PROPERTIES.has(property)) continue;
        violations.push({
          rule: "R2",
          id: RULES.R2.id,
          element: describeElement(element),
          animation: name,
          property,
          message: `<use> has a non-zero x/y offset (attribute or CSS) and also animates "${property}" via "${name}". ${RULES.R2.hint}`,
        });
      }
    }
  }
}

function addAnimatedUseTargetViolations(elements, animationsByElement, keyframes, violations, notes) {
  const byId = new Map();
  const byNode = new Map();
  for (const element of elements) {
    byNode.set(element.node, element);
    if (element.id) byId.set(element.id, element);
  }
  const seen = new Set();
  const seenNotes = new Set();

  const addUnresolvedTargetNote = (element, href, reason) => {
    const elementDescription = describeElement(element);
    const key = `${elementDescription}\u0000${href}`;
    if (seenNotes.has(key)) return;
    seenNotes.add(key);
    notes.push({
      type: "unresolved-use-target",
      selector: null,
      element: elementDescription,
      href,
      reason,
      hint: "Point href at an existing local id, or extend the audit if this reference form should be modeled.",
    });
  };

  const collectSubtree = (root) => {
    const out = [root];
    const visit = (element) => {
      for (const child of element.node.children || []) {
        const match = byNode.get(child);
        if (!match) continue;
        out.push(match);
        visit(match);
      }
    };
    visit(root);
    return out;
  };

  for (const element of elements) {
    if (element.name !== "use") continue;
    const href = element.node.attribs.href || element.node.attribs["xlink:href"];
    if (!href || !href.trim().startsWith("#")) continue;

    let fragment;
    try {
      fragment = decodeURIComponent(href.trim().slice(1));
    } catch {
      addUnresolvedTargetNote(element, href, "The href fragment has malformed percent-encoding.");
      continue;
    }

    const target = byId.get(fragment);
    if (!target) {
      addUnresolvedTargetNote(element, href, `No element with id "${fragment}" exists.`);
      continue;
    }

    for (const node of collectSubtree(target)) {
      const names = animationsByElement.get(node);
      if (!names) continue;
      for (const name of names) {
        // Multiple <use> elements can point at the same definition; the
        // animation defect belongs to the definition, so report it once.
        const key = `${target.id}\u0000${describeElement(node)}\u0000${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({
          rule: "R3",
          id: RULES.R3.id,
          element: describeElement(node),
          animation: name,
          property: [...keyframes.get(name).properties].join(", "),
          message: `<use href="#${target.id}"> points at content whose ${describeElement(node)} is animated by "${name}". ${RULES.R3.hint}`,
        });
      }
    }
  }
}

function addSmilViolations(elements, violations) {
  for (const element of elements) {
    if (!SMIL_TAGS.has(element.name)) continue;
    violations.push({
      rule: "R4",
      id: RULES.R4.id,
      element: describeElement(element),
      animation: `<${element.name}>`,
      property: null,
      message: `<${element.name}> is SMIL, which keeps the document on the main thread. ${RULES.R4.hint}`,
    });
  }
}

function addNestedSvgViolations(document, violations) {
  function visit(node, insideSvg) {
    if (!node) return;
    const isSvg = node.type === "tag" && (node.name || "").toLowerCase() === "svg";
    if (isSvg && insideSvg) {
      const className = node.attribs && node.attribs.class ? node.attribs.class : "";
      violations.push({
        rule: "R5",
        id: RULES.R5.id,
        element: describeElement({
          name: "svg",
          id: node.attribs && node.attribs.id ? node.attribs.id : "",
          classes: className.split(/\s+/).filter(Boolean),
        }),
        animation: "<svg>",
        property: null,
        message: "Nested <svg> element found inside the root <svg>. " + RULES.R5.hint,
      });
    }
    for (const child of node.children || []) visit(child, insideSvg || isSvg);
  }

  for (const child of document.children || []) visit(child, false);
}

/**
 * Audit one SVG document.
 *
 * @param {string} markup SVG source. CRLF is normalized before parsing.
 * @returns {{
 *   animations: Array<{element: string, name: string, properties: string[]}>,
 *   violations: Array<{rule: string, id: string, element: string, animation: string|null, property: string|null, message: string}>,
 *   notes: Array<{type: string, selector: string|null, reason?: string, hint?: string, element?: string, value?: string, href?: string}>
 * }}
 */
function auditSvgCompositing(markup) {
  const normalized = String(markup).replace(/\r\n/g, "\n");
  const document = parseDocument(normalized, { xmlMode: true });
  const elements = collectElements(document);
  const css = parseCss(collectStyleText(elements));
  const animationsByElement = collectAnimationsByElement(elements, css.rules, css.keyframes, css.unsupported);

  const animations = [];
  for (const [element, names] of animationsByElement) {
    for (const name of names) {
      animations.push({
        element: describeElement(element),
        name,
        properties: [...css.keyframes.get(name).properties],
      });
    }
  }

  const violations = [];
  addKeyframeViolations(css.keyframes, animationsByElement, violations);
  addElementCompositionViolations(elements, css.rules, violations);
  addUseTranslationViolations(elements, css.rules, animationsByElement, css.keyframes, violations);
  addAnimatedUseTargetViolations(elements, animationsByElement, css.keyframes, violations, css.unsupported);
  addSmilViolations(elements, violations);
  addNestedSvgViolations(document, violations);

  return { animations, violations, notes: css.unsupported };
}

module.exports = {
  auditSvgCompositing,
  COMPOSITED_PROPERTIES,
  RULES,
};
