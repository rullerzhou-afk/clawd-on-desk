"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  normalizeMusicAuraSettings,
  validateMusicAuraSettings,
} = require("../src/music-aura-settings");
const {
  createMusicAuraMain,
  MAX_SCAN_TRACKS,
  scanLibrary,
} = require("../src/music-aura-main");

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-music-aura-"));
  tempDirs.push(dir);
  return dir;
}

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "");
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("music aura settings", () => {
  it("normalizes defaults and constrained option values", () => {
    const cfg = normalizeMusicAuraSettings({
      enabled: true,
      libraryDirs: [" /music ", "/music", "", "/other"],
      volume: 3,
      visualStyle: "planet",
      particlesAlwaysOn: false,
      backgroundAdaptation: "light",
      intensity: "stage",
      performance: "turbo",
      particleOpacity: 1.7,
      glowStrength: 0.35,
      pointScale: 0.64,
      particleDensity: 1.4,
      particlePalette: "contrast",
      autoViewMode: "strong",
      backplateStyle: "stage",
      auraOffsetX: 0.16,
      auraOffsetY: -0.12,
      auraScale: 1.08,
      auraPlacementByTheme: {
        clawd: { offsetX: 0.2, offsetY: -0.1, scale: 1.1 },
        calico: { offsetX: 0.8, offsetY: -0.8, scale: 3 },
      },
      lowPerformanceProtection: false,
      autoStart: true,
    });
    assert.strictEqual(cfg.enabled, true);
    assert.deepStrictEqual(cfg.libraryDirs, ["/music", "/other"]);
    assert.strictEqual(cfg.volume, 1);
    assert.strictEqual(cfg.visualStyle, "planet");
    assert.strictEqual(cfg.particlesAlwaysOn, false);
    assert.strictEqual(cfg.backgroundAdaptation, "light");
    assert.strictEqual(cfg.intensity, "stage");
    assert.strictEqual(cfg.performance, "auto");
    assert.strictEqual(cfg.particleOpacity, 1.7);
    assert.strictEqual(cfg.glowStrength, 0.35);
    assert.strictEqual(cfg.pointScale, 0.64);
    assert.strictEqual(cfg.particleDensity, 1.4);
    assert.strictEqual(cfg.particlePalette, "contrast");
    assert.strictEqual(cfg.autoViewMode, "strong");
    assert.strictEqual(cfg.backplateStyle, "stage");
    assert.strictEqual(cfg.auraOffsetX, 0.16);
    assert.strictEqual(cfg.auraOffsetY, -0.12);
    assert.strictEqual(cfg.auraScale, 1.08);
    assert.deepStrictEqual(cfg.auraPlacementByTheme, {
      clawd: { offsetX: 0.2, offsetY: -0.1, scale: 1.1 },
      calico: { offsetX: 0, offsetY: 0, scale: 1 },
    });
    assert.strictEqual(cfg.lowPerformanceProtection, false);
    assert.strictEqual(cfg.autoStart, true);
    assert.strictEqual(cfg.shuffle, true);
  });

  it("falls back to safe visual defaults", () => {
    const cfg = normalizeMusicAuraSettings({
      visualStyle: "laser",
      particlesAlwaysOn: "sometimes",
      backgroundAdaptation: "invisible",
      particleOpacity: 99,
      glowStrength: -5,
      pointScale: "huge",
      particleDensity: 12,
      particlePalette: "white",
      autoViewMode: "wild",
      backplateStyle: "glass",
      auraOffsetX: 9,
      auraOffsetY: -9,
      auraScale: 3,
      auraPlacementByTheme: {
        bad: { offsetX: "far", offsetY: null, scale: 0.2 },
      },
      lowPerformanceProtection: "off",
    });

    assert.strictEqual(cfg.visualStyle, "galaxy");
    assert.strictEqual(cfg.particlesAlwaysOn, true);
    assert.strictEqual(cfg.backgroundAdaptation, "auto");
    assert.strictEqual(cfg.particleOpacity, 1.18);
    assert.strictEqual(cfg.glowStrength, 1.25);
    assert.strictEqual(cfg.pointScale, 0.82);
    assert.strictEqual(cfg.particleDensity, 1);
    assert.strictEqual(cfg.particlePalette, "default");
    assert.strictEqual(cfg.autoViewMode, "standard");
    assert.strictEqual(cfg.backplateStyle, "dark");
    assert.strictEqual(cfg.auraOffsetX, 0);
    assert.strictEqual(cfg.auraOffsetY, 0);
    assert.strictEqual(cfg.auraScale, 1);
    assert.deepStrictEqual(cfg.auraPlacementByTheme, {
      bad: { offsetX: 0, offsetY: 0, scale: 1 },
    });
    assert.strictEqual(cfg.lowPerformanceProtection, true);
  });

  it("keeps legacy visual style values readable", () => {
    assert.strictEqual(normalizeMusicAuraSettings({ visualStyle: "hologram" }).visualStyle, "galaxy");
    assert.strictEqual(normalizeMusicAuraSettings({ visualStyle: "aurora" }).visualStyle, "aurora");
    assert.strictEqual(normalizeMusicAuraSettings({ visualStyle: "vinyl" }).visualStyle, "vinyl");
  });

  it("keeps the old Mineradio palette value as a dedicated cold-white palette", () => {
    assert.strictEqual(normalizeMusicAuraSettings({ particlePalette: "mineradio" }).particlePalette, "mineradio");
  });

  it("rejects unnormalized values in the settings write path", () => {
    assert.deepStrictEqual(validateMusicAuraSettings(normalizeMusicAuraSettings({ enabled: true })), { status: "ok" });
    assert.strictEqual(validateMusicAuraSettings({ enabled: "yes" }).status, "error");
    assert.strictEqual(validateMusicAuraSettings({ enabled: true, unknown: 1 }).status, "error");
  });
});

describe("scanLibrary", () => {
  it("finds supported audio files and skips unsupported files", () => {
    const root = makeTempDir();
    touch(path.join(root, "A Song.mp3"));
    touch(path.join(root, "nested", "B-Track.FLAC"));
    touch(path.join(root, "notes.txt"));

    const result = scanLibrary({ libraryDirs: [root] });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.count, 2);
    assert.deepStrictEqual(result.tracks.map((track) => track.title), ["A Song", "B Track"]);
    assert.ok(result.tracks.every((track) => track.url.startsWith("file://")));
  });

  it("reports missing directories and caps very large libraries", () => {
    const root = makeTempDir();
    for (let i = 0; i < MAX_SCAN_TRACKS + 4; i += 1) {
      touch(path.join(root, `track-${String(i).padStart(4, "0")}.mp3`));
    }

    const result = scanLibrary({ libraryDirs: [path.join(root, "missing"), root] });
    assert.strictEqual(result.count, MAX_SCAN_TRACKS);
    assert.strictEqual(result.truncated, true);
    assert.deepStrictEqual(result.missingDirs, [path.join(root, "missing")]);
  });
});

describe("createMusicAuraMain", () => {
  it("does not rescan the library when non-directory settings change", () => {
    const root = makeTempDir();
    touch(path.join(root, "song.mp3"));
    let settings = normalizeMusicAuraSettings({ libraryDirs: [root], volume: 0.4 });
    let readdirCalls = 0;
    const wrappedFs = {
      ...fs,
      readdirSync(...args) {
        readdirCalls += 1;
        return fs.readdirSync(...args);
      },
    };
    const aura = createMusicAuraMain({
      fs: wrappedFs,
      path,
      settingsController: {
        get(key) {
          return key === "musicAura" ? settings : undefined;
        },
      },
    });

    aura.refreshLibrary({ force: true });
    const afterInitialScan = readdirCalls;
    settings = normalizeMusicAuraSettings({
      ...settings,
      volume: 0.8,
      intensity: "stage",
      visualStyle: "planet",
      particlesAlwaysOn: false,
      backgroundAdaptation: "contrast",
      particleOpacity: 1.35,
      glowStrength: 1.45,
      pointScale: 0.72,
          particleDensity: 1.2,
          particlePalette: "neon",
          autoViewMode: "subtle",
          auraOffsetX: -0.08,
          auraOffsetY: 0.12,
          auraScale: 0.94,
          auraPlacementByTheme: {
            clawd: { offsetX: 0.1, offsetY: -0.06, scale: 1.04 },
          },
          lowPerformanceProtection: false,
        });
    aura.applySettingsChange();

    assert.strictEqual(readdirCalls, afterInitialScan);
  });

  it("keeps renderer visual diagnostics in runtime status", () => {
    const aura = createMusicAuraMain({
      fs,
      path,
      settingsController: {
        get(key) {
          return key === "musicAura" ? normalizeMusicAuraSettings({ enabled: true }) : undefined;
        },
      },
    });

    aura.updateStatus({
      playing: false,
      visual: {
        active: true,
        visible: true,
        webglReady: true,
        particleCount: 640,
        style: "aurora",
        backgroundAdaptation: "contrast",
        error: "",
      },
      currentTime: 42.25,
      duration: 180.5,
    });

    assert.deepStrictEqual(aura.getRuntime().status.visual, {
      active: true,
      visible: true,
      webglReady: true,
      particleCount: 640,
      style: "aurora",
      backgroundAdaptation: "contrast",
      error: "",
    });
    assert.strictEqual(aura.getRuntime().status.currentTime, 42.25);
    assert.strictEqual(aura.rendererBootstrap().status.currentTime, 42.25);
    assert.strictEqual(aura.rendererBootstrap().status.playing, false);
  });

  it("exposes compact library tracks to the settings player", () => {
    const root = makeTempDir();
    touch(path.join(root, "Alpha.mp3"));
    touch(path.join(root, "Beta.flac"));
    const aura = createMusicAuraMain({
      fs,
      path,
      settingsController: {
        get(key) {
          return key === "musicAura" ? normalizeMusicAuraSettings({ libraryDirs: [root] }) : undefined;
        },
      },
    });

    const runtime = aura.getRuntime();

    assert.strictEqual(runtime.library.count, 2);
    assert.deepStrictEqual(runtime.library.tracks.map((track) => ({
      title: track.title,
      fileName: track.fileName,
      index: track.index,
    })), [
      { title: "Alpha", fileName: "Alpha.mp3", index: 0 },
      { title: "Beta", fileName: "Beta.flac", index: 1 },
    ]);
    assert.ok(runtime.library.tracks.every((track) => !("path" in track) && !("url" in track)));
  });

  it("keeps enough playback state for renderer reload recovery", () => {
    const aura = createMusicAuraMain({
      fs,
      path,
      settingsController: {
        get(key) {
          return key === "musicAura" ? normalizeMusicAuraSettings({ enabled: true }) : undefined;
        },
      },
    });

    aura.updateStatus({
      playing: true,
      track: { id: "abc", title: "Song", fileName: "song.mp3" },
      trackIndex: 2,
      count: 5,
      currentTime: 12.75,
      duration: 90,
    });

    assert.deepStrictEqual(aura.rendererBootstrap().status, {
      playing: true,
      track: { id: "abc", title: "Song", fileName: "song.mp3" },
      trackIndex: 2,
      count: 5,
      error: "",
      visual: null,
      currentTime: 12.75,
      duration: 90,
    });
  });
});

describe("music aura renderer", () => {
  function readRendererSource() {
    return fs.readFileSync(path.join(__dirname, "..", "src", "music-aura-renderer.js"), "utf8");
  }

  function readStylesSource() {
    return fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
  }

  function readIndexSource() {
    return fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  }

  function cssRule(source, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "m"));
    assert.ok(match, `Expected CSS rule for ${selector}`);
    return match[1];
  }

  it("keeps planet deformation as coherent spherical waves", () => {
    const source = readRendererSource();

    assert.match(source, /float travelWave =/);
    assert.match(source, /float latWave =/);
    assert.match(source, /uniform float u_musicActive;/);
    assert.match(source, /uniform float u_planetWaveClock;/);
    assert.match(source, /let planetWaveClock = 0;/);
    assert.match(source, /const bassSpeed = bass \* 0\.22;/);
    assert.match(source, /const midSpeed = mid \* 1\.05;/);
    assert.match(source, /const trebleSpeed = treble \* 0\.68;/);
    assert.match(source, /const planetWaveSpeed = clamp\(0\.10 \+ bassSpeed \+ midSpeed \+ trebleSpeed, 0\.08, 1\.55, 0\.10\);/);
    assert.match(source, /planetWaveClock \+= elapsed \* planetWaveSpeed;/);
    assert.match(source, /const musicActive = !audio\.paused && !audio\.ended \? 1 : 0;/);
    assert.match(source, /gl\.uniform1f\(gl\.getUniformLocation\(program, "u_planetWaveClock"\), planetWaveClock\);/);
    assert.match(source, /gl\.uniform1f\(gl\.getUniformLocation\(program, "u_musicActive"\), musicActive\);/);
    assert.match(source, /vec3 randomSpherePoint\(float seed\)/);
    assert.match(source, /float waveIndex = floor\(waveClock\);/);
    assert.match(source, /float waveProgress = fract\(waveClock\);/);
    assert.match(source, /vec3 source = randomSpherePoint\(waveIndex\);/);
    assert.match(source, /vec3 antipode = -source;/);
    assert.match(source, /float sourceDistance = acos\(clamp\(dot\(normal, source\), -1\.0, 1\.0\)\);/);
    assert.match(source, /float antipodeDistance = acos\(clamp\(dot\(normal, antipode\), -1\.0, 1\.0\)\);/);
    assert.match(source, /float waveFront = waveProgress \* 3\.1415926;/);
    assert.match(source, /float wavePhase = sourceDistance - waveFront;/);
    assert.match(source, /float primaryWave = exp\(-\(wavePhase \* wavePhase\) \/ 0\.070\);/);
    assert.match(source, /float trailingTrough = -0\.32 \* exp\(-\(\(wavePhase \+ 0\.26\) \* \(wavePhase \+ 0\.26\)\) \/ 0\.090\);/);
    assert.match(source, /float ringPulse =/);
    assert.match(source, /float bassBreath =/);
    assert.match(source, /float planetWake = mix\(0\.50, 0\.88, u_musicActive\);/);
    assert.match(source, /float waveGlow = primaryWave \* cycleFade \* \(0\.48 \+ u_mid \* 0\.20 \+ u_treble \* 0\.36\);/);
    assert.match(source, /float audioAlpha = u_visualStyle > 1\.5 && u_visualStyle < 2\.5 \? u_musicActive \* 0\.24 : \(u_treble \* 0\.32 \+ u_bass \* 0\.30 \+ beat \* 0\.18\);/);
    assert.match(source, /base = settings\.visualStyle === "planet" \? Math\.round\(base \* 1\.55\) : base;/);
    assert.match(source, /0\.365 \+ deformation/);
    assert.match(source, /float waveAmplitude = 0\.030 \+ u_bass \* 0\.014 \+ u_mid \* 0\.010;/);
    assert.match(source, /float planetPointBoost = u_visualStyle > 1\.5 && u_visualStyle < 2\.5 \? abs\(deformation\) \* 0\.75 : abs\(deformation\) \* 2\.4;/);
    assert.doesNotMatch(source, /vec3 sourceA =/);
    assert.doesNotMatch(source, /vec3 sourceB =/);
    assert.doesNotMatch(source, /sourceWaveA/);
    assert.doesNotMatch(source, /sourceWaveB/);
    assert.doesNotMatch(source, /sourcePulse/);
    assert.doesNotMatch(source, /antipodePulse/);
    assert.doesNotMatch(source, /crestWave/);
    assert.doesNotMatch(source, /surfaceWave/);
    assert.doesNotMatch(source, /innerRipple/);
    assert.doesNotMatch(source, /float waveSpeed =/);
    assert.doesNotMatch(source, /float waveClock = u_time \* waveSpeed/);
    assert.doesNotMatch(source, /styleSize = .*crestEnvelope/);
    assert.doesNotMatch(source, /styleAlpha = 0\.74 \+ primaryWave/);
    assert.doesNotMatch(source, /patchMask/);
    assert.doesNotMatch(source, /patchWave/);
    assert.doesNotMatch(source, /blockWave/);
    assert.doesNotMatch(source, /u_mid \* 0\.120/);
    assert.doesNotMatch(source, /abs\(waveLift\) \* 4\.5/);
    assert.doesNotMatch(source, /float patchA = [^;]*rnd/);
    assert.doesNotMatch(source, /float patchB = [^;]*rnd/);
    assert.doesNotMatch(source, /treblePatch/);
    assert.doesNotMatch(source, /inwardDent/);
  });

  it("lets the settings playlist request a specific track index", () => {
    const source = readRendererSource();

    assert.match(source, /const commandPayload = payload && typeof payload\.payload === "object" \? payload\.payload : payload;/);
    assert.match(source, /if \(command === "play-index"\) return playIndex\(Number\(commandPayload\.index\)\);/);
  });

  it("anchors the aura independently from the raw window center", () => {
    const source = readRendererSource();

    assert.match(source, /uniform vec2 u_auraOffset;/);
    assert.match(source, /uniform float u_auraScale;/);
    assert.match(source, /function computeAuraPlacement\(\)/);
    assert.match(source, /function themePlacement\(\)/);
    assert.match(source, /currentThemeId/);
    assert.match(source, /gl\.uniform2f\(gl\.getUniformLocation\(program, "u_auraOffset"\)/);
    assert.match(source, /gl\.uniform1f\(gl\.getUniformLocation\(program, "u_auraScale"\)/);
  });

  it("renders the dark aura backplate below the particle canvas and pet", () => {
    const index = readIndexSource();
    const styles = readStylesSource();

    assert.match(index, /<div id="music-aura-backplate" aria-hidden="true"><\/div>\s*<canvas id="music-aura-canvas"/);
    assert.match(styles, /#music-aura-backplate\s*\{[\s\S]*?z-index:\s*0;/);
    assert.match(styles, /#music-aura-canvas\s*\{[\s\S]*?z-index:\s*1;/);
    assert.match(styles, /#clawd\s*\{[\s\S]*?z-index:\s*2;/);
    assert.match(styles, /#pet-container\.mini-left #music-aura-backplate\s*\{/);
  });

  it("draws the default aura backplate as a full-layer radial patch without a boxed shadow", () => {
    const styles = readStylesSource();
    const backplateRule = cssRule(styles, "#music-aura-backplate");
    const darkRule = cssRule(styles, "#music-aura-backplate::before");

    assert.match(backplateRule, /inset:\s*0;/);
    assert.doesNotMatch(backplateRule, /\bwidth:\s*\d/);
    assert.doesNotMatch(backplateRule, /\bheight:\s*\d/);
    assert.doesNotMatch(backplateRule, /border-radius:\s*999px/);
    assert.doesNotMatch(backplateRule, /translate\(/);

    assert.match(darkRule, /radial-gradient\(/);
    assert.match(darkRule, /at calc\(50% \+ var\(--music-aura-backplate-x\)\) calc\(50% \+ var\(--music-aura-backplate-y\)\)/);
    assert.doesNotMatch(darkRule, /box-shadow:/);
  });

  it("syncs the aura backplate visibility and placement from the renderer", () => {
    const source = readRendererSource();

    assert.match(source, /document\.getElementById\("music-aura-backplate"\)/);
    assert.match(source, /backplateStyle: "dark"/);
    assert.match(source, /\["off", "dark", "stage"\]\.includes\(source\.backplateStyle\)/);
    assert.match(source, /function syncBackplate\(visible, placement\)/);
    assert.match(source, /backplate\.classList\.toggle\("active", visible && settings\.backplateStyle !== "off"\)/);
    assert.match(source, /backplate\.classList\.toggle\("style-stage", settings\.backplateStyle === "stage"\)/);
    assert.match(source, /backplate\.classList\.toggle\("style-dark", settings\.backplateStyle !== "stage"\)/);
    assert.match(source, /backplate\.style\.setProperty\("--music-aura-backplate-x"/);
    assert.match(source, /backplate\.style\.setProperty\("--music-aura-backplate-y"/);
    assert.match(source, /backplate\.style\.setProperty\("--music-aura-backplate-radius-x"/);
    assert.match(source, /backplate\.style\.setProperty\("--music-aura-backplate-radius-y"/);
    assert.match(source, /backplate\.style\.setProperty\("--music-aura-backplate-scale"/);
  });

  it("renders the Mineradio palette as cold white with ice-blue and warm highlights", () => {
    const source = readRendererSource();

    assert.match(source, /settings\.particlePalette === "mineradio"/);
    assert.match(source, /vec3\(0\.92,\s*0\.98,\s*1\.0\)/);
    assert.match(source, /vec3\(0\.72,\s*0\.91,\s*1\.0\)/);
    assert.match(source, /vec3\(1\.0,\s*0\.96,\s*0\.78\)/);
    assert.doesNotMatch(source, /vec3\(0\.61,\s*1\.0,\s*0\.87\)/);
  });

  it("does not mirror the aura canvas in left mini mode", () => {
    const source = readStylesSource();

    assert.match(source, /#pet-container\.mini-left #music-aura-canvas\s*\{/);
    assert.match(source, /scaleX\(-1\) scale\(1\.22\)/);
  });
});
