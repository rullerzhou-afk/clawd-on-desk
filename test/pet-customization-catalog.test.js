"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
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
  resolvePetAccessoryPayload,
  listPetAccessoryOptions,
  PET_MOUTH_ACCESSORY_CATALOG,
  PET_MOUTH_ACCESSORY_IDS,
  PET_ACCESSORY_SLOTS,
  isPetMouthAccessoryId,
  getPetMouthAccessory,
  getPetMouthAccessoryIdForTheme,
  isPetMouthAccessorySupportedForTheme,
  buildPetMouthAccessoryPayload,
  listPetMouthAccessoryOptions,
} = require("../src/pet-customization-catalog");

describe("pet customization catalog", () => {
  it("keeps one ordered, immutable source of truth for persisted tint ids", () => {
    assert.deepStrictEqual(
      PET_TINT_IDS,
      ["none", "midnight", "gold", "vaporwave", "matcha", "mono"]
    );
    assert.strictEqual(new Set(PET_TINT_IDS).size, PET_TINT_IDS.length);
    assert.ok(Object.isFrozen(PET_TINT_CATALOG));
    assert.ok(PET_TINT_CATALOG.every(Object.isFrozen));
    assert.ok(Object.isFrozen(PET_TINT_IDS));
  });

  it("exposes labels to Settings without exposing CSS filter values", () => {
    const options = listPetTintOptions();
    assert.deepStrictEqual(
      options,
      PET_TINT_CATALOG.map(({ id, labelKey }) => ({ id, labelKey }))
    );
    assert.ok(options.every((entry) => !Object.prototype.hasOwnProperty.call(entry, "filter")));
  });

  it("resolves only catalog entries and safely falls back to none", () => {
    assert.strictEqual(isPetTintId("gold"), true);
    assert.strictEqual(isPetTintId("custom"), false);
    assert.strictEqual(getPetTint("custom").id, "none");
    assert.deepStrictEqual(resolvePetTintPayload("custom"), { id: "none", filter: "" });
    assert.deepStrictEqual(resolvePetTintPayload(null), { id: "none", filter: "" });
  });

  it("resolves independent per-theme choices and accepts the short-lived legacy scalar", () => {
    const selections = {
      clawd: "matcha",
      cloudling: "vaporwave",
      calico: "custom",
    };
    assert.strictEqual(getPetTintIdForTheme(selections, "clawd"), "matcha");
    assert.strictEqual(getPetTintIdForTheme(selections, "cloudling"), "vaporwave");
    assert.strictEqual(getPetTintIdForTheme(selections, "calico"), "none");
    assert.strictEqual(getPetTintIdForTheme(selections, "missing"), "none");
    assert.strictEqual(getPetTintIdForTheme("gold", "clawd"), "gold");
    assert.strictEqual(getPetTintIdForTheme(null, "clawd"), "none");
  });

  it("opts unsupported themes out without changing the persisted semantic choice", () => {
    const calico = { _id: "calico", _builtin: true, _capabilities: { petTint: false } };
    assert.strictEqual(isPetTintSupportedForTheme(calico), false);
    assert.deepStrictEqual(
      resolvePetTintPayload("vaporwave", calico),
      { id: "none", filter: "" }
    );
  });

  it("keeps semantic labels stable while swapping Cloudling's vaporwave and matcha recipes", () => {
    const clawd = { _id: "clawd", _builtin: true, _capabilities: { petTint: true } };
    const cloudling = { _id: "cloudling", _builtin: true, _capabilities: { petTint: true } };

    assert.strictEqual(isPetTintSupportedForTheme(clawd), true);
    assert.deepStrictEqual(resolvePetTintPayload("vaporwave", clawd), {
      id: "vaporwave",
      filter: getPetTint("vaporwave").filter,
    });
    assert.deepStrictEqual(resolvePetTintPayload("vaporwave", cloudling), {
      id: "vaporwave",
      filter: getPetTint("matcha").filter,
    });
    assert.deepStrictEqual(resolvePetTintPayload("matcha", cloudling), {
      id: "matcha",
      filter: getPetTint("vaporwave").filter,
    });
  });

  it("does not apply built-in aliases to an untrusted theme with the same id", () => {
    const external = { _id: "cloudling", _builtin: false, _capabilities: { petTint: true } };
    assert.strictEqual(
      resolvePetTintPayload("vaporwave", external).filter,
      getPetTint("vaporwave").filter
    );
  });

  it("contains only the renderer's deliberately narrow local filter grammar", () => {
    const token =
      /^(?:hue-rotate\(-?\d+(?:\.\d+)?deg\)|(?:saturate|brightness|contrast|sepia|grayscale)\(\d+(?:\.\d+)?\))$/;
    for (const entry of PET_TINT_CATALOG) {
      assert.match(entry.id, /^[a-z][a-z0-9-]{0,31}$/);
      assert.match(entry.labelKey, /^[A-Za-z][A-Za-z0-9]{0,63}$/);
      if (entry.id === "none") {
        assert.strictEqual(entry.filter, "");
      } else {
        assert.ok(entry.filter.split(/\s+/).every((part) => token.test(part)), entry.filter);
      }
      assert.doesNotMatch(entry.filter, /url|var|;|#/i);
    }
  });

  it("keeps one ordered, deeply immutable source of truth for accessory ids and geometry", () => {
    assert.deepStrictEqual(
      PET_ACCESSORY_IDS,
      [
        "none",
        "cowboy-hat",
        "western-cowboy-hat",
        "party-hat",
        "wizard-hat",
        "top-hat",
        "santa-hat",
        "pumpkin-hat",
        "halo",
      ]
    );
    assert.strictEqual(new Set(PET_ACCESSORY_IDS).size, PET_ACCESSORY_IDS.length);
    assert.ok(Object.isFrozen(PET_ACCESSORY_CATALOG));
    assert.ok(PET_ACCESSORY_CATALOG.every(Object.isFrozen));
    assert.ok(PET_ACCESSORY_CATALOG.filter((entry) => entry.viewBox).every((entry) => (
      Object.isFrozen(entry.viewBox)
    )));
    assert.ok(Object.isFrozen(PET_ACCESSORY_IDS));
  });

  it("exposes only accessory ids and labels to Settings", () => {
    const options = listPetAccessoryOptions();
    assert.deepStrictEqual(
      options,
      PET_ACCESSORY_CATALOG.map(({ id, labelKey }) => ({ id, labelKey }))
    );
    for (const entry of options) {
      assert.deepStrictEqual(Object.keys(entry).sort(), ["id", "labelKey"]);
    }
  });

  it("resolves safe accessory payloads only for capable themes", () => {
    const clawd = { _id: "clawd", _capabilities: { accessories: true } };
    const calico = { _id: "calico", _capabilities: { accessories: false } };

    assert.strictEqual(isPetAccessoryId("wizard-hat"), true);
    assert.strictEqual(isPetAccessoryId("seasonal"), false);
    assert.strictEqual(getPetAccessory("custom").id, "none");
    assert.strictEqual(isPetAccessorySupportedForTheme(clawd), true);
    assert.strictEqual(isPetAccessorySupportedForTheme(calico), false);
    assert.deepStrictEqual(resolvePetAccessoryPayload("wizard-hat", clawd), {
      id: "wizard-hat",
      assetFile: "wizard-hat.svg",
      aspect: 15 / 16,
      widthScale: 0.95,
      offsetY: 0.3,
    });
    assert.deepStrictEqual(resolvePetAccessoryPayload("western-cowboy-hat", clawd), {
      id: "western-cowboy-hat",
      assetFile: "western-cowboy-hat.svg",
      aspect: 17 / 5,
      widthScale: 1.0625,
      offsetY: -0.5,
    });
    assert.deepStrictEqual(resolvePetAccessoryPayload("wizard-hat", calico), {
      id: "none",
      assetFile: null,
      aspect: 1,
      widthScale: 1,
      offsetY: 0,
    });
    assert.deepStrictEqual(resolvePetAccessoryPayload("custom", clawd), {
      id: "none",
      assetFile: null,
      aspect: 1,
      widthScale: 1,
      offsetY: 0,
    });
  });

  it("applies the smaller halo scale only to the built-in Clawd theme", () => {
    const builtinClawd = {
      _id: "clawd",
      _builtin: true,
      _capabilities: { accessories: true },
    };
    const builtinCloudling = {
      _id: "cloudling",
      _builtin: true,
      _capabilities: { accessories: true },
    };
    const externalClawd = {
      _id: "clawd",
      _builtin: false,
      _capabilities: { accessories: true },
    };

    assert.strictEqual(resolvePetAccessoryPayload("halo", builtinClawd).widthScale, 0.9);
    assert.strictEqual(resolvePetAccessoryPayload("halo", builtinCloudling).widthScale, 1.15);
    assert.strictEqual(resolvePetAccessoryPayload("halo", externalClawd).widthScale, 1.15);
    assert.strictEqual(resolvePetAccessoryPayload("wizard-hat", builtinClawd).widthScale, 0.95);
  });

  it("resolves accessories per theme without accepting the discarded global scalar shape", () => {
    const selections = {
      clawd: "wizard-hat",
      cloudling: "halo",
      calico: "seasonal",
    };
    assert.strictEqual(getPetAccessoryIdForTheme(selections, "clawd"), "wizard-hat");
    assert.strictEqual(getPetAccessoryIdForTheme(selections, "cloudling"), "halo");
    assert.strictEqual(getPetAccessoryIdForTheme(selections, "calico"), "none");
    assert.strictEqual(getPetAccessoryIdForTheme(selections, "missing"), "none");
    assert.strictEqual(getPetAccessoryIdForTheme("wizard-hat", "clawd"), "none");
    assert.strictEqual(getPetAccessoryIdForTheme(null, "clawd"), "none");
  });

  it("keeps accessory assets and geometry inside a narrow local grammar", () => {
    for (const entry of PET_ACCESSORY_CATALOG) {
      assert.match(entry.id, /^[a-z][a-z0-9-]{0,31}$/);
      assert.match(entry.labelKey, /^[A-Za-z][A-Za-z0-9]{0,63}$/);
      assert.ok(Number.isFinite(entry.widthScale) && entry.widthScale > 0);
      assert.ok(Number.isFinite(entry.offsetY));
      if (entry.themeWidthScales) {
        assert.ok(Object.isFrozen(entry.themeWidthScales));
        for (const [themeId, widthScale] of Object.entries(entry.themeWidthScales)) {
          assert.match(themeId, /^[a-z][a-z0-9-]{0,31}$/);
          assert.ok(Number.isFinite(widthScale) && widthScale >= 0.25 && widthScale <= 2.5);
        }
      }
      if (entry.id === "none") {
        assert.strictEqual(entry.file, null);
        assert.strictEqual(entry.viewBox, null);
      } else {
        assert.match(entry.file, /^[a-z0-9][a-z0-9-]*\.svg$/);
        assert.ok(entry.viewBox.width > 0);
        assert.ok(entry.viewBox.height > 0);
      }
    }
  });

  it("keeps head compatibility exports and a separate immutable mouth catalog", () => {
    assert.deepStrictEqual(PET_MOUTH_ACCESSORY_IDS, ["none", "cigarette"]);
    assert.ok(Object.isFrozen(PET_MOUTH_ACCESSORY_CATALOG));
    assert.ok(PET_MOUTH_ACCESSORY_CATALOG.every(Object.isFrozen));
    assert.ok(Object.isFrozen(PET_MOUTH_ACCESSORY_IDS));
    assert.deepStrictEqual(Object.keys(PET_ACCESSORY_SLOTS), ["head", "mouth"]);
    assert.strictEqual(PET_ACCESSORY_SLOTS.head.preferenceKey, "petAccessory");
    assert.strictEqual(PET_ACCESSORY_SLOTS.mouth.preferenceKey, "petMouthAccessory");
  });

  it("resolves only trusted mouth catalog payloads for mouth-capable themes", () => {
    const clawd = { _id: "clawd", _capabilities: { mouthAccessories: true } };
    const cloudling = { _id: "cloudling", _capabilities: { mouthAccessories: false } };
    assert.strictEqual(isPetMouthAccessoryId("cigarette"), true);
    assert.strictEqual(isPetMouthAccessoryId("pipe"), false);
    assert.strictEqual(getPetMouthAccessory("pipe").id, "none");
    assert.strictEqual(isPetMouthAccessorySupportedForTheme(clawd), true);
    assert.strictEqual(isPetMouthAccessorySupportedForTheme(cloudling), false);
    assert.deepStrictEqual(buildPetMouthAccessoryPayload("cigarette", clawd), {
      id: "cigarette",
      assetFile: "cigarette.svg",
      aspect: 5 / 9,
      widthScale: 1,
      offsetY: 0,
    });
    assert.deepStrictEqual(buildPetMouthAccessoryPayload("cigarette", cloudling), {
      id: "none",
      assetFile: null,
      aspect: 1,
      widthScale: 1,
      offsetY: 0,
    });
    assert.strictEqual(getPetMouthAccessoryIdForTheme({ clawd: "cigarette" }, "clawd"), "cigarette");
    assert.strictEqual(getPetMouthAccessoryIdForTheme("cigarette", "clawd"), "none");
    assert.deepStrictEqual(listPetMouthAccessoryOptions(), [
      { id: "none", labelKey: "accessoryNone" },
      { id: "cigarette", labelKey: "accessoryCigarette" },
    ]);
  });
});
