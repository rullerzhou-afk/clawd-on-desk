"use strict";

(function exposePetAccessoryLayout(root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else if (root) {
    root.petAccessoryLayout = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createPetAccessoryLayout() {
  const MAX_COORD = 100000;
  const MAX_TARGET_COORD = 8192;
  const MAX_TARGET_WIDTH = 4096;
  const MAX_LAYOUT_MULTIPLIER = 4;

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function finiteWithin(value, limit) {
    return finite(value) && Math.abs(value) <= limit;
  }

  function normalizeAccessory(accessory) {
    if (!accessory || typeof accessory !== "object") return null;
    const aspect = accessory.aspect;
    const widthScale = accessory.widthScale;
    const offsetY = accessory.offsetY;
    if (!finite(aspect) || aspect < 0.1 || aspect > 10) return null;
    if (!finite(widthScale) || widthScale < 0.25 || widthScale > 2.5) return null;
    if (!finite(offsetY) || Math.abs(offsetY) > 64) return null;
    return { aspect, widthScale, offsetY };
  }

  function normalizeFrame(frame, limits = {}) {
    if (!frame || typeof frame !== "object") return null;
    const coordLimit = limits.coordLimit || MAX_TARGET_COORD;
    const widthLimit = limits.widthLimit || MAX_TARGET_WIDTH;
    if (!finiteWithin(frame.cx, coordLimit)) return null;
    if (!finiteWithin(frame.baseY, coordLimit)) return null;
    if (!finite(frame.width) || frame.width <= 0 || frame.width > widthLimit) return null;
    return { cx: frame.cx, baseY: frame.baseY, width: frame.width };
  }

  function normalizeViewBox(viewBox) {
    if (!viewBox || typeof viewBox !== "object") return null;
    if (!finiteWithin(viewBox.x, MAX_COORD) || !finiteWithin(viewBox.y, MAX_COORD)) return null;
    if (!finite(viewBox.width) || viewBox.width <= 0 || viewBox.width > MAX_COORD) return null;
    if (!finite(viewBox.height) || viewBox.height <= 0 || viewBox.height > MAX_COORD) return null;
    return {
      x: viewBox.x,
      y: viewBox.y,
      width: viewBox.width,
      height: viewBox.height,
    };
  }

  function normalizeBox(box) {
    if (!box || typeof box !== "object") return null;
    if (!finiteWithin(box.x, MAX_COORD) || !finiteWithin(box.y, MAX_COORD)) return null;
    if (!finite(box.width) || box.width <= 0 || box.width > MAX_COORD) return null;
    if (!finite(box.height) || box.height <= 0 || box.height > MAX_COORD) return null;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }

  function normalizeMatrix(matrix) {
    if (!matrix || typeof matrix !== "object") return null;
    const out = {};
    for (const key of ["a", "b", "c", "d", "e", "f"]) {
      if (!finiteWithin(matrix[key], MAX_COORD)) return null;
      out[key] = matrix[key];
    }
    return out;
  }

  function buildAccessoryRect(frame, accessory) {
    const width = frame.width * accessory.widthScale;
    const height = width / accessory.aspect;
    if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
    return {
      x: frame.cx - width / 2,
      y: frame.baseY + accessory.offsetY - height,
      width,
      height,
    };
  }

  function multiplyTranslate(matrix, x, y) {
    return {
      a: matrix.a,
      b: matrix.b,
      c: matrix.c,
      d: matrix.d,
      e: matrix.e + matrix.a * x + matrix.c * y,
      f: matrix.f + matrix.b * x + matrix.d * y,
    };
  }

  function transformedBounds(matrix, width, height) {
    const points = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
    ].map(([x, y]) => ({
      x: matrix.a * x + matrix.c * y + matrix.e,
      y: matrix.b * x + matrix.d * y + matrix.f,
    }));
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }

  function finalizeLayout(matrix, rect, stageSize) {
    const normalizedMatrix = normalizeMatrix(matrix);
    if (!normalizedMatrix || !rect) return null;
    const bounds = transformedBounds(normalizedMatrix, rect.width, rect.height);
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(finite)) return null;
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    if (stageSize) {
      const stage = normalizeBox({ x: 0, y: 0, ...stageSize });
      if (!stage) return null;
      const maxWidth = stage.width * MAX_LAYOUT_MULTIPLIER;
      const maxHeight = stage.height * MAX_LAYOUT_MULTIPLIER;
      if (bounds.width > maxWidth || bounds.height > maxHeight) return null;
      if (bounds.x < -stage.width || bounds.x > stage.width * 2) return null;
      if (bounds.y < -stage.height || bounds.y > stage.height * 2) return null;
      if (bounds.x + bounds.width < -stage.width || bounds.x + bounds.width > stage.width * 3) return null;
      if (bounds.y + bounds.height < -stage.height || bounds.y + bounds.height > stage.height * 3) return null;
    }
    return {
      matrix: normalizedMatrix,
      width: rect.width,
      height: rect.height,
      bounds,
    };
  }

  function computeStaticAccessoryLayout(input) {
    if (!input || typeof input !== "object") return null;
    const mediaBox = normalizeBox(input.mediaBox);
    const viewBox = normalizeViewBox(input.viewBox);
    const accessory = normalizeAccessory(input.accessory);
    if (!mediaBox || !viewBox || !accessory) return null;
    const frame = normalizeFrame(input.frame, {
      coordLimit: MAX_COORD,
      widthLimit: viewBox.width * MAX_LAYOUT_MULTIPLIER,
    });
    if (!frame) return null;
    if (frame.cx < viewBox.x - viewBox.width || frame.cx > viewBox.x + viewBox.width * 2) return null;
    if (frame.baseY < viewBox.y - viewBox.height || frame.baseY > viewBox.y + viewBox.height * 2) return null;

    const rect = buildAccessoryRect(frame, accessory);
    if (!rect) return null;
    const scale = Math.min(mediaBox.width / viewBox.width, mediaBox.height / viewBox.height);
    if (!finite(scale) || scale <= 0) return null;
    const matrix = {
      a: scale,
      b: 0,
      c: 0,
      d: scale,
      e: mediaBox.x + (mediaBox.width - viewBox.width * scale) / 2 - viewBox.x * scale,
      f: mediaBox.y + (mediaBox.height - viewBox.height * scale) / 2 - viewBox.y * scale,
    };
    return finalizeLayout(
      multiplyTranslate(matrix, rect.x, rect.y),
      rect,
      input.stageSize
    );
  }

  function computeDynamicAccessoryLayout(input) {
    if (!input || typeof input !== "object") return null;
    const matrix = normalizeMatrix(input.matrix);
    const accessory = normalizeAccessory(input.accessory);
    const frame = normalizeFrame(input.frame);
    const mediaOffset = input.mediaOffset;
    if (!matrix || !accessory || !frame || !mediaOffset) return null;
    if (!finiteWithin(mediaOffset.x, MAX_COORD) || !finiteWithin(mediaOffset.y, MAX_COORD)) return null;
    const rect = buildAccessoryRect(frame, accessory);
    if (!rect) return null;
    let projected = multiplyTranslate({
      ...matrix,
      e: matrix.e + mediaOffset.x,
      f: matrix.f + mediaOffset.y,
    }, rect.x, rect.y);
    if (
      input.normalizeReflection === "x"
      && projected.a * projected.d - projected.b * projected.c < 0
    ) {
      // Preserve the full-CTM projected rectangle and its screen position,
      // then counter-reflect only the accessory pixels around their local
      // center. Taking abs(a) would move the image to the opposite side.
      projected = {
        a: -projected.a,
        b: -projected.b,
        c: projected.c,
        d: projected.d,
        e: projected.e + projected.a * rect.width,
        f: projected.f + projected.b * rect.width,
      };
    }
    return finalizeLayout(projected, rect, input.stageSize);
  }

  function layoutsEqual(a, b, epsilon = 0.0001) {
    if (!a || !b || !finite(epsilon) || epsilon < 0) return false;
    const valuesA = [
      a.width,
      a.height,
      a.matrix && a.matrix.a,
      a.matrix && a.matrix.b,
      a.matrix && a.matrix.c,
      a.matrix && a.matrix.d,
      a.matrix && a.matrix.e,
      a.matrix && a.matrix.f,
    ];
    const valuesB = [
      b.width,
      b.height,
      b.matrix && b.matrix.a,
      b.matrix && b.matrix.b,
      b.matrix && b.matrix.c,
      b.matrix && b.matrix.d,
      b.matrix && b.matrix.e,
      b.matrix && b.matrix.f,
    ];
    return valuesA.every((value, index) => (
      finite(value)
      && finite(valuesB[index])
      && Math.abs(value - valuesB[index]) <= epsilon
    ));
  }

  return {
    computeStaticAccessoryLayout,
    computeDynamicAccessoryLayout,
    transformedBounds,
    layoutsEqual,
  };
});
