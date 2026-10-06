"use strict";

const path = require("path");

const DANGEROUS_TAGS = new Set([
  "script", "foreignobject", "iframe", "embed", "object", "applet",
  "meta", "link", "base", "form", "input", "textarea", "button",
]);
const DANGEROUS_ATTR_RE = /^on/i;
const DANGEROUS_HREF_RE = /^\s*javascript\s*:/i;
const EXTERNAL_RESOURCE_RE = /^\s*(?:\/\/|(https?|data|file|ftp)\s*:)/i;
const PATH_TRAVERSAL_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const HREF_ATTRS = new Set(["href", "src", "action", "formaction"]);
const SVG_URL_ATTRS = new Set([
  "style",
  "fill",
  "stroke",
  "filter",
  "clip-path",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
  "cursor",
]);
const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const ROOT_ABSOLUTE_PATH_RE = /^[\\/](?![\\/])/;
const ANIMATION_TAGS = new Set(["animate", "animatetransform", "animatemotion", "set"]);
const DYNAMIC_VALUE_ATTRS = ["from", "to", "by", "values"];
const DYNAMIC_JAVASCRIPT_RE = /javascript\s*:/i;

function xmlLocalName(name) {
  const qualified = typeof name === "string" ? name.toLowerCase() : "";
  const separator = qualified.lastIndexOf(":");
  return separator >= 0 ? qualified.slice(separator + 1) : qualified;
}

function normalizeCssSecurityText(value) {
  if (typeof value !== "string" || !value) return value || "";
  const withoutComments = value.replace(/\/\*[\s\S]*?\*\//g, "");
  const decodedEscapes = withoutComments.replace(
    /\\([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|\\([^\n\f\r])/gi,
    (_match, hex, escaped) => {
      if (hex) {
        const codePoint = Number.parseInt(hex, 16);
        if (!Number.isFinite(codePoint) || codePoint === 0 || codePoint > 0x10ffff) return "\uFFFD";
        return String.fromCodePoint(codePoint);
      }
      return escaped || "";
    }
  );
  // URL parsers discard ASCII tab/newline/CR inside schemes. Remove them from
  // the security-only comparison too so CSS escapes such as `h\\9 ttps:` and
  // `javascr\\a ipt:` cannot reconstruct an external or script URL later.
  return decodedEscapes.replace(/[\t\n\r]/g, "");
}

function getAttributeCaseInsensitive(attribs, wanted) {
  if (!attribs || typeof attribs !== "object") return undefined;
  const key = Object.keys(attribs).find((candidate) => candidate.toLowerCase() === wanted);
  return key === undefined ? undefined : attribs[key];
}

function hasUnsafeDynamicAnimation(node) {
  if (!node || !node.attribs) return false;
  const rawAnimatedAttribute = getAttributeCaseInsensitive(node.attribs, "attributename");
  const animatedAttribute = typeof rawAnimatedAttribute === "string"
    ? xmlLocalName(rawAnimatedAttribute.trim())
    : "";
  if (
    DANGEROUS_ATTR_RE.test(animatedAttribute)
    || HREF_ATTRS.has(animatedAttribute)
    || animatedAttribute === "style"
  ) return true;

  for (const key of DYNAMIC_VALUE_ATTRS) {
    const value = getAttributeCaseInsensitive(node.attribs, key);
    if (typeof value !== "string") continue;
    const decoded = decodeResourceTarget(value);
    const normalizedCss = normalizeCssSecurityText(value);
    const decodedNormalizedCss = decodeResourceTarget(normalizedCss);
    if (
      DYNAMIC_JAVASCRIPT_RE.test(value)
      || DYNAMIC_JAVASCRIPT_RE.test(decoded)
      || DYNAMIC_JAVASCRIPT_RE.test(normalizedCss)
      || DYNAMIC_JAVASCRIPT_RE.test(decodedNormalizedCss)
      || containsUnsafeCssUrl(normalizedCss)
    ) return true;
  }
  return false;
}

function sanitizeSvg(svgContent) {
  const { parseDocument } = require("htmlparser2");
  const render = require("dom-serializer");

  const doc = parseDocument(svgContent, { xmlMode: true });
  sanitizeNode(doc);
  return render.default(doc, { xmlMode: true });
}

function collectSafeRasterRefs(svgContent, sourceAssetsDir) {
  const out = new Map();
  let doc;
  try {
    const { parseDocument } = require("htmlparser2");
    doc = parseDocument(svgContent, { xmlMode: true });
  } catch {
    return out;
  }

  function visit(node) {
    if (!node) return;
    if (node.attribs) {
      for (const [rawKey, value] of Object.entries(node.attribs)) {
        const key = xmlLocalName(rawKey);
        if (key === "href") {
          const ref = normalizeRasterReference(value, sourceAssetsDir);
          if (ref) out.set(ref.destRel, ref);
        }
        if (key === "style" || SVG_URL_ATTRS.has(key)) {
          collectCssUrlRefs(value, out, sourceAssetsDir);
        }
      }
    }
    if ((node.type === "style" || (node.type === "tag" && (node.name || "").toLowerCase() === "style")) && node.children) {
      for (const child of node.children) {
        if (child.type === "text") collectCssUrlRefs(child.data, out, sourceAssetsDir);
      }
    }
    if (node.children) {
      for (const child of node.children) visit(child);
    }
  }

  visit(doc);
  return out;
}

function unwrapCssUrlTarget(rawValue) {
  if (typeof rawValue !== "string") return "";
  const trimmed = rawValue.trim();
  const singleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
  const doubleQuoted = trimmed.startsWith("\"") && trimmed.endsWith("\"");
  if ((singleQuoted || doubleQuoted) && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function decodeResourceTarget(target) {
  if (typeof target !== "string" || !target) return target || "";
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function stripUrlSuffix(value) {
  if (typeof value !== "string") return "";
  const hashIndex = value.indexOf("#");
  const queryIndex = value.indexOf("?");
  const cut = [hashIndex, queryIndex].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  return cut == null ? value : value.slice(0, cut);
}

function hasUnsafeResourcePattern(target) {
  if (!target) return false;
  return DANGEROUS_HREF_RE.test(target)
    || EXTERNAL_RESOURCE_RE.test(target)
    || PATH_TRAVERSAL_RE.test(target)
    || WINDOWS_ABSOLUTE_PATH_RE.test(target)
    || ROOT_ABSOLUTE_PATH_RE.test(target);
}

function isUnsafeHrefTarget(rawValue) {
  const target = unwrapCssUrlTarget(rawValue);
  if (!target || target.startsWith("#")) return false;
  const decoded = decodeResourceTarget(target);
  return hasUnsafeResourcePattern(target) || hasUnsafeResourcePattern(decoded);
}

function isUnsafeCssUrlTarget(rawValue) {
  const target = unwrapCssUrlTarget(rawValue);
  if (!target || target.startsWith("#")) return false;
  return isUnsafeHrefTarget(target);
}

function sanitizeCssUrls(cssText) {
  if (typeof cssText !== "string" || !cssText) return cssText;
  return cssText
    .replace(/@import\b[^;]*/gi, "/* sanitized */")
    .replace(/url\s*\(\s*([^)]*?)\s*\)/gi, (match, rawTarget) => (
      isUnsafeCssUrlTarget(rawTarget) ? "url()" : match
    ));
}

function containsUnsafeCssUrl(cssText) {
  if (typeof cssText !== "string" || !cssText) return false;
  const matches = cssText.matchAll(/url\s*\(\s*([^)]*?)\s*\)/gi);
  for (const match of matches) {
    if (isUnsafeCssUrlTarget(match[1])) return true;
  }
  return false;
}

function normalizeRasterReference(rawValue, sourceAssetsDir) {
  const target = unwrapCssUrlTarget(rawValue);
  if (!target || target.startsWith("#")) return null;
  const decoded = decodeResourceTarget(target);
  if (!decoded || decoded.startsWith("#")) return null;
  if (hasUnsafeResourcePattern(target) || hasUnsafeResourcePattern(decoded)) return null;

  const withoutSuffix = stripUrlSuffix(decoded).replace(/\\/g, "/");
  if (!withoutSuffix || withoutSuffix.startsWith("#")) return null;
  const normalized = path.posix.normalize(withoutSuffix);
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
    return null;
  }

  const ext = path.posix.extname(normalized).toLowerCase();
  if (ext !== ".webp" && ext !== ".png") return null;

  const sourceAbs = path.resolve(sourceAssetsDir, ...normalized.split("/"));
  if (!isPathInsideDir(sourceAssetsDir, sourceAbs)) return null;
  const sourceKey = process.platform === "win32" ? sourceAbs.toLowerCase() : sourceAbs;
  return { destRel: normalized, sourceRel: normalized, sourceAbs, sourceKey };
}

function collectCssUrlRefs(value, out, sourceAssetsDir) {
  if (typeof value !== "string" || !value) return;
  for (const match of value.matchAll(/url\s*\(\s*([^)]*?)\s*\)/gi)) {
    const ref = normalizeRasterReference(match[1], sourceAssetsDir);
    if (ref) out.set(ref.destRel, ref);
  }
}

function isPathInsideDir(baseDir, candidatePath) {
  if (!baseDir || !candidatePath) return false;
  const base = path.resolve(baseDir);
  const candidate = path.resolve(candidatePath);
  const relative = path.relative(base, candidate);
  const firstSegment = relative.split(/[\\/]/)[0];
  return relative === "" || (!!relative && firstSegment !== ".." && !path.isAbsolute(relative));
}

function sanitizeNode(node) {
  if (!node.children) return;

  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];

    if (child.type === "tag" || child.type === "script" || child.type === "style") {
      const tagName = xmlLocalName(child.name);
      if (DANGEROUS_TAGS.has(tagName)) {
        node.children.splice(i, 1);
        continue;
      }
      // SMIL can mutate attributes after the static markup has been sanitized.
      // Reject animations that target URL/event/style surfaces or smuggle an
      // unsafe URL through from/to/by/values; otherwise a safe initial href can
      // become executable only after the document-backed SVG starts running.
      if (ANIMATION_TAGS.has(tagName) && hasUnsafeDynamicAnimation(child)) {
        node.children.splice(i, 1);
        continue;
      }
    }

    if (child.type === "style" || (child.type === "tag" && xmlLocalName(child.name) === "style")) {
      if (child.children) {
        for (const textNode of child.children) {
          if (textNode.type === "text" && textNode.data) {
            textNode.data = sanitizeCssUrls(textNode.data);
          }
        }
      }
    }

    if (child.attribs) {
      const keys = Object.keys(child.attribs);
      for (const key of keys) {
        const localKey = xmlLocalName(key);
        if (DANGEROUS_ATTR_RE.test(localKey)) {
          delete child.attribs[key];
          continue;
        }
        if (HREF_ATTRS.has(localKey)) {
          const val = child.attribs[key];
          if (isUnsafeHrefTarget(val)) {
            delete child.attribs[key];
            continue;
          }
        }
        if (SVG_URL_ATTRS.has(localKey)) {
          const val = child.attribs[key];
          if (localKey === "style") {
            const sanitized = sanitizeCssUrls(val);
            if (!sanitized || !sanitized.trim()) delete child.attribs[key];
            else child.attribs[key] = sanitized;
          } else if (containsUnsafeCssUrl(val)) {
            delete child.attribs[key];
          }
        }
      }
    }

    sanitizeNode(child);
  }
}

module.exports = {
  sanitizeSvg,
  collectSafeRasterRefs,
};
