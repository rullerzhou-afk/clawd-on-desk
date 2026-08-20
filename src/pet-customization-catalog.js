"use strict";

const { commitPetAccessoryPayload } = require("./pet-accessory-state");

// Canonical catalogs for pet customization choices. Persisted settings store
// stable ids only; renderer-facing values are resolved here so neither menus
// nor untrusted preference data can supply CSS filters or asset paths.

const PET_TINT_CATALOG = Object.freeze([
  Object.freeze({ id: "none", labelKey: "tintNone", filter: "" }),
  Object.freeze({ id: "midnight", labelKey: "tintMidnight", filter: "hue-rotate(200deg) saturate(1.2) brightness(0.82)" }),
  Object.freeze({ id: "gold", labelKey: "tintGold", filter: "sepia(0.8) saturate(2.2) hue-rotate(-18deg) brightness(1.05)" }),
  Object.freeze({ id: "vaporwave", labelKey: "tintVaporwave", filter: "hue-rotate(265deg) saturate(1.6) contrast(1.05)" }),
  Object.freeze({ id: "matcha", labelKey: "tintMatcha", filter: "hue-rotate(75deg) saturate(1.25) brightness(1)" }),
  Object.freeze({ id: "mono", labelKey: "tintMono", filter: "grayscale(1) brightness(1.05)" }),
]);

const PET_TINT_BY_ID = new Map(PET_TINT_CATALOG.map((entry) => [entry.id, entry]));
const PET_TINT_IDS = Object.freeze(PET_TINT_CATALOG.map((entry) => entry.id));
const PET_TINT_THEME_ALIASES = Object.freeze({
  cloudling: Object.freeze({ vaporwave: "matcha", matcha: "vaporwave" }),
});

function freezeAccessory({ id, labelKey, file = null, viewBox = null, widthScale = 1, offsetY = 0, themeWidthScales = null }) {
  return Object.freeze({
    id,
    labelKey,
    file,
    viewBox: viewBox ? Object.freeze({ ...viewBox }) : null,
    widthScale,
    offsetY,
    themeWidthScales: themeWidthScales ? Object.freeze({ ...themeWidthScales }) : null,
  });
}

const PET_ACCESSORY_CATALOG = Object.freeze([
  freezeAccessory({ id: "none", labelKey: "accessoryNone" }),
  freezeAccessory({ id: "cowboy-hat", labelKey: "accessoryCowboyHat", file: "cowboy-hat.svg", viewBox: { x: 0, y: 0, width: 16, height: 7 } }),
  freezeAccessory({ id: "party-hat", labelKey: "accessoryPartyHat", file: "party-hat.svg", viewBox: { x: 0, y: 0, width: 11, height: 14 }, widthScale: 0.7, offsetY: 0.3 }),
  freezeAccessory({ id: "wizard-hat", labelKey: "accessoryWizardHat", file: "wizard-hat.svg", viewBox: { x: 0, y: 0, width: 15, height: 16 }, widthScale: 0.95, offsetY: 0.3 }),
  freezeAccessory({ id: "top-hat", labelKey: "accessoryTopHat", file: "top-hat.svg", viewBox: { x: 0, y: 0, width: 14, height: 10 }, widthScale: 0.88, offsetY: 0.2 }),
  freezeAccessory({ id: "santa-hat", labelKey: "accessorySantaHat", file: "santa-hat.svg", viewBox: { x: 0, y: 0, width: 16, height: 9 }, offsetY: 0.2 }),
  freezeAccessory({ id: "pumpkin-hat", labelKey: "accessoryPumpkinHat", file: "pumpkin-hat.svg", viewBox: { x: 0, y: 0, width: 13, height: 9 }, widthScale: 0.85, offsetY: 0.4 }),
  freezeAccessory({ id: "halo", labelKey: "accessoryHalo", file: "halo.svg", viewBox: { x: 0, y: 0, width: 14, height: 5 }, widthScale: 1.15, offsetY: -1.4, themeWidthScales: { clawd: 0.9 } }),
]);

const PET_ACCESSORY_BY_ID = new Map(PET_ACCESSORY_CATALOG.map((entry) => [entry.id, entry]));
const PET_ACCESSORY_IDS = Object.freeze(PET_ACCESSORY_CATALOG.map((entry) => entry.id));

function isPetTintId(value) {
  return typeof value === "string" && PET_TINT_BY_ID.has(value);
}

function getPetTint(value) {
  return PET_TINT_BY_ID.get(value) || PET_TINT_BY_ID.get("none");
}

function getPetTintIdForTheme(selections, themeId) {
  if (typeof selections === "string") return getPetTint(selections).id;
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) return "none";
  if (typeof themeId !== "string" || !themeId) return "none";
  return getPetTint(selections[themeId]).id;
}

function isPetTintSupportedForTheme(theme) {
  if (!theme) return true;
  return !!(theme._capabilities && theme._capabilities.petTint === true);
}

function resolvePetTintPayload(value, theme = null) {
  const entry = getPetTint(value);
  if (!isPetTintSupportedForTheme(theme)) return { id: "none", filter: "" };
  const themeAliases = theme && theme._builtin === true ? PET_TINT_THEME_ALIASES[theme._id] : null;
  const recipeId = (themeAliases && themeAliases[entry.id]) || entry.id;
  const recipe = getPetTint(recipeId);
  return { id: entry.id, filter: recipe.filter };
}

function listPetTintOptions() {
  return PET_TINT_CATALOG.map(({ id, labelKey }) => ({ id, labelKey }));
}

function isPetAccessoryId(value) {
  return typeof value === "string" && PET_ACCESSORY_BY_ID.has(value);
}

function getPetAccessory(value) {
  return PET_ACCESSORY_BY_ID.get(value) || PET_ACCESSORY_BY_ID.get("none");
}

function getPetAccessoryIdForTheme(selections, themeId) {
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) return "none";
  if (typeof themeId !== "string" || !themeId) return "none";
  return getPetAccessory(selections[themeId]).id;
}

function isPetAccessorySupportedForTheme(theme) {
  if (!theme) return false;
  return !!(theme._capabilities && theme._capabilities.accessories === true);
}

// Pure resolver for callers that must not make a candidate authoritative until
// renderer delivery succeeds (Settings and holiday refresh use this path).
function buildPetAccessoryPayload(value, theme = null) {
  const entry = getPetAccessory(value);
  const supported = isPetAccessorySupportedForTheme(theme);
  if (!supported || entry.id === "none") {
    return { id: "none", assetFile: null, aspect: 1, widthScale: 1, offsetY: 0 };
  }
  return {
    id: entry.id,
    assetFile: entry.file,
    aspect: entry.viewBox.width / entry.viewBox.height,
    widthScale: (
      theme
      && theme._builtin === true
      && entry.themeWidthScales
      && entry.themeWidthScales[theme._id]
    ) || entry.widthScale,
    offsetY: entry.offsetY,
  };
}

// Renderer config/theme reloads call this resolver. Committing here means the
// exact payload handed to the renderer also becomes the main-process geometry
// authority, instead of geometry independently re-resolving settings/date.
function resolvePetAccessoryPayload(value, theme = null) {
  const payload = buildPetAccessoryPayload(value, theme);
  return commitPetAccessoryPayload(payload, theme).payload;
}

function listPetAccessoryOptions() {
  return PET_ACCESSORY_CATALOG.map(({ id, labelKey }) => ({ id, labelKey }));
}

module.exports = {
  PET_TINT_CATALOG,
  PET_TINT_IDS,
  isPetTintId,
  getPetTint,
  getPetTintIdForTheme,
  isPetTintSupportedForTheme,
  resolvePetTintPayload,
  listPetTintOptions,
  PET_ACCESSORY_CATALOG,
  PET_ACCESSORY_IDS,
  isPetAccessoryId,
  getPetAccessory,
  getPetAccessoryIdForTheme,
  isPetAccessorySupportedForTheme,
  buildPetAccessoryPayload,
  resolvePetAccessoryPayload,
  listPetAccessoryOptions,
};
