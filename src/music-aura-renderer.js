"use strict";

(function initMusicAuraRenderer(root) {
  const api = root.electronAPI || null;
  const canvas = document.getElementById("music-aura-canvas");
  if (!api || !canvas) return;

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    libraryDirs: [],
    volume: 0.55,
    shuffle: true,
    autoStart: false,
    visualEnabled: true,
    visualStyle: "galaxy",
    particlesAlwaysOn: true,
    backgroundAdaptation: "auto",
    particleOpacity: 1.18,
    glowStrength: 1.25,
    pointScale: 0.82,
    particleDensity: 1,
    particlePalette: "default",
    autoViewMode: "standard",
    auraOffsetX: 0,
    auraOffsetY: 0,
    auraScale: 1,
    auraPlacementByTheme: {},
    intensity: "vivid",
    performance: "auto",
    lowPerformanceProtection: true,
    stateReactive: true,
    miniModeEnabled: true,
    continueWhenHidden: true,
  });

  const STATE_ENERGY = Object.freeze({
    idle: 0.52,
    "mini-idle": 0.46,
    dozing: 0.28,
    working: 1.08,
    thinking: 0.9,
    juggling: 1.2,
    sweeping: 1.02,
    confirm: 1.16,
    notification: 1.12,
    complete: 0.78,
    error: 1.24,
  });

  const audio = new Audio();
  audio.preload = "auto";
  audio.loop = false;

  let settings = { ...DEFAULT_SETTINGS };
  let tracks = [];
  let currentIndex = -1;
  let currentState = "idle";
  let miniMode = false;
  let audioContext = null;
  let analyser = null;
  let sourceNode = null;
  let frequencyData = null;
  let lastError = "";

  let gl = null;
  let program = null;
  let seedBuffer = null;
  let seedCount = 0;
  let rafId = null;
  let startedAt = performance.now();
  let lastVisualFrameAt = 0;
  let planetWaveClock = 0;
  let bass = 0;
  let mid = 0;
  let treble = 0;
  let lastVisible = false;
  let lastStatusReportAt = 0;
  let currentThemeId = themeIdFromConfig(root.themeConfig);

  function normalizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const visualStyle = source.visualStyle === "hologram"
      ? "galaxy"
      : (["galaxy", "vinyl", "planet", "tunnel", "aurora"].includes(source.visualStyle)
        ? source.visualStyle
        : DEFAULT_SETTINGS.visualStyle);
    return {
      ...DEFAULT_SETTINGS,
      ...source,
      libraryDirs: Array.isArray(source.libraryDirs) ? source.libraryDirs.slice() : [],
      volume: clamp(Number(source.volume), 0, 1, DEFAULT_SETTINGS.volume),
      visualStyle,
      particlesAlwaysOn: typeof source.particlesAlwaysOn === "boolean"
        ? source.particlesAlwaysOn
        : DEFAULT_SETTINGS.particlesAlwaysOn,
      backgroundAdaptation: ["auto", "dark", "light", "contrast"].includes(source.backgroundAdaptation)
        ? source.backgroundAdaptation
        : DEFAULT_SETTINGS.backgroundAdaptation,
      particleOpacity: clamp(Number(source.particleOpacity), 0.2, 1.8, DEFAULT_SETTINGS.particleOpacity),
      glowStrength: clamp(Number(source.glowStrength), 0, 1.8, DEFAULT_SETTINGS.glowStrength),
      pointScale: clamp(Number(source.pointScale), 0.45, 1.4, DEFAULT_SETTINGS.pointScale),
      particleDensity: clamp(Number(source.particleDensity), 0.45, 1.5, DEFAULT_SETTINGS.particleDensity),
      particlePalette: source.particlePalette === "mineradio"
        ? "default"
        : (["default", "contrast", "aurora", "neon", "warm"].includes(source.particlePalette)
          ? source.particlePalette
          : DEFAULT_SETTINGS.particlePalette),
      autoViewMode: ["off", "subtle", "standard", "strong"].includes(source.autoViewMode)
        ? source.autoViewMode
        : DEFAULT_SETTINGS.autoViewMode,
      auraOffsetX: boundedNumber(source.auraOffsetX, -0.35, 0.35, DEFAULT_SETTINGS.auraOffsetX),
      auraOffsetY: boundedNumber(source.auraOffsetY, -0.35, 0.35, DEFAULT_SETTINGS.auraOffsetY),
      auraScale: boundedNumber(source.auraScale, 0.7, 1.35, DEFAULT_SETTINGS.auraScale),
      auraPlacementByTheme: normalizeAuraPlacementByTheme(source.auraPlacementByTheme),
      intensity: ["subtle", "vivid", "stage"].includes(source.intensity) ? source.intensity : DEFAULT_SETTINGS.intensity,
      performance: ["eco", "auto", "high"].includes(source.performance) ? source.performance : DEFAULT_SETTINGS.performance,
      lowPerformanceProtection: typeof source.lowPerformanceProtection === "boolean"
        ? source.lowPerformanceProtection
        : DEFAULT_SETTINGS.lowPerformanceProtection,
    };
  }

  function clamp(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
  }

  function boundedNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) return fallback;
    return n;
  }

  function normalizeAuraPlacementByTheme(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out = {};
    for (const [key, rawPlacement] of Object.entries(value)) {
      const themeId = String(key || "").trim();
      if (!themeId || themeId.length > 80) continue;
      const placement = rawPlacement && typeof rawPlacement === "object" && !Array.isArray(rawPlacement)
        ? rawPlacement
        : {};
      out[themeId] = {
        offsetX: boundedNumber(placement.offsetX, -0.35, 0.35, 0),
        offsetY: boundedNumber(placement.offsetY, -0.35, 0.35, 0),
        scale: boundedNumber(placement.scale, 0.7, 1.35, 1),
      };
    }
    return out;
  }

  function themeIdFromConfig(config) {
    return config && typeof config.themeId === "string" && config.themeId
      ? config.themeId
      : "";
  }

  function getTrackSummary(track) {
    if (!track) return null;
    return {
      id: track.id || "",
      title: track.title || track.fileName || "",
      fileName: track.fileName || "",
    };
  }

  function reportStatus(error = lastError) {
    lastError = error || "";
    if (typeof api.reportMusicAuraStatus !== "function") return;
    api.reportMusicAuraStatus({
      playing: !audio.paused && !audio.ended,
      track: getTrackSummary(tracks[currentIndex]),
      trackIndex: currentIndex,
      count: tracks.length,
      error: lastError,
      currentTime: Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0,
      duration: Number.isFinite(audio.duration) ? Math.max(0, audio.duration) : 0,
      visual: {
        active: settings.enabled && settings.visualEnabled,
        visible: lastVisible,
        webglReady: !!(gl && program),
        particleCount: seedCount,
        style: settings.visualStyle,
        backgroundAdaptation: settings.backgroundAdaptation,
        error: lastError,
      },
    });
  }

  function reportPlaybackProgress() {
    const now = performance.now();
    if (audio.paused || now - lastStatusReportAt <= 1000) return;
    lastStatusReportAt = now;
    reportStatus();
  }

  function ensureAudioGraph() {
    if (audioContext && analyser) return true;
    const AudioContextCtor = root.AudioContext || root.webkitAudioContext;
    if (!AudioContextCtor) return false;
    audioContext = new AudioContextCtor();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.78;
    frequencyData = new Uint8Array(analyser.frequencyBinCount);
    if (!sourceNode) {
      sourceNode = audioContext.createMediaElementSource(audio);
      sourceNode.connect(analyser);
      analyser.connect(audioContext.destination);
    }
    return true;
  }

  async function resumeAudioGraph() {
    if (!ensureAudioGraph()) return;
    if (audioContext && audioContext.state === "suspended") {
      try { await audioContext.resume(); } catch {}
    }
  }

  function chooseNextIndex(direction) {
    if (!tracks.length) return -1;
    if (currentIndex < 0 || currentIndex >= tracks.length) return 0;
    if (settings.shuffle && direction > 0 && tracks.length > 1) {
      let next = currentIndex;
      for (let i = 0; i < 5 && next === currentIndex; i += 1) {
        next = Math.floor(Math.random() * tracks.length);
      }
      return next === currentIndex ? (currentIndex + 1) % tracks.length : next;
    }
    return (currentIndex + direction + tracks.length) % tracks.length;
  }

  function seekAudio(seconds) {
    const target = Number(seconds);
    if (!Number.isFinite(target) || target <= 0) return;
    const safeTarget = Number.isFinite(audio.duration) && audio.duration > 1
      ? Math.min(target, Math.max(0, audio.duration - 0.5))
      : target;
    const applySeek = () => {
      try { audio.currentTime = safeTarget; } catch {}
    };
    if (audio.readyState >= 1) {
      applySeek();
      return;
    }
    audio.addEventListener("loadedmetadata", applySeek, { once: true });
  }

  async function playIndex(index, options = {}) {
    if (!settings.enabled) {
      reportStatus("Music Aura is disabled");
      return;
    }
    if (!tracks.length) {
      reportStatus("No local tracks found");
      return;
    }
    const safeIndex = clamp(Math.floor(index), 0, tracks.length - 1, 0);
    const track = tracks[safeIndex];
    if (!track || !track.url) {
      reportStatus("Track URL is unavailable");
      return;
    }
    currentIndex = safeIndex;
    await resumeAudioGraph();
    if (audio.src !== track.url) audio.src = track.url;
    audio.volume = settings.volume;
    seekAudio(options.startTime);
    try {
      await audio.play();
      reportStatus("");
      startVisualLoop();
    } catch (err) {
      reportStatus(err && err.message ? err.message : "Playback failed");
    }
  }

  function pausePlayback() {
    try { audio.pause(); } catch {}
    reportStatus("");
    syncCanvasVisibility();
  }

  function togglePlayback() {
    if (!settings.enabled) {
      reportStatus("Music Aura is disabled");
      return;
    }
    if (audio.paused || audio.ended) {
      const index = currentIndex >= 0 ? currentIndex : chooseNextIndex(1);
      playIndex(index);
    } else {
      pausePlayback();
    }
  }

  function nextTrack() {
    playIndex(chooseNextIndex(1));
  }

  function previousTrack() {
    playIndex(chooseNextIndex(-1));
  }

  function applySettings(nextSettings) {
    const wasEnabled = settings.enabled;
    const oldPerformance = settings.performance;
    const oldDensity = settings.particleDensity;
    settings = normalizeSettings(nextSettings);
    audio.volume = settings.volume;
    if (!settings.enabled) pausePlayback();
    if (oldPerformance !== settings.performance || oldDensity !== settings.particleDensity) rebuildParticles();
    if (!wasEnabled && settings.enabled && settings.autoStart && tracks.length) {
      playIndex(currentIndex >= 0 ? currentIndex : 0);
    }
    syncCanvasVisibility();
  }

  function applyLibrary(library) {
    const previousId = tracks[currentIndex] && tracks[currentIndex].id;
    tracks = Array.isArray(library && library.tracks) ? library.tracks.slice() : [];
    if (previousId) {
      const nextIndex = tracks.findIndex((track) => track && track.id === previousId);
      currentIndex = nextIndex >= 0 ? nextIndex : (tracks.length ? 0 : -1);
    } else if (currentIndex >= tracks.length) {
      currentIndex = tracks.length ? 0 : -1;
    }
    reportStatus("");
    if (settings.enabled && settings.autoStart && audio.paused && tracks.length) {
      playIndex(currentIndex >= 0 ? currentIndex : 0);
    }
  }

  function handleCommand(payload) {
    const command = payload && typeof payload === "object" ? payload.command : payload;
    if (command === "play") return playIndex(currentIndex >= 0 ? currentIndex : chooseNextIndex(1));
    if (command === "pause") return pausePlayback();
    if (command === "next") return nextTrack();
    if (command === "previous") return previousTrack();
    if (command === "toggle") return togglePlayback();
  }

  function createShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "shader compile failed");
    }
    return shader;
  }

  function createProgram() {
    const vertex = createShader(gl.VERTEX_SHADER, `
      attribute vec4 a_seed;
      uniform float u_time;
      uniform float u_bass;
      uniform float u_mid;
      uniform float u_treble;
      uniform float u_state;
      uniform float u_intensity;
      uniform float u_aspect;
      uniform float u_pixelRatio;
      uniform float u_backgroundAdaptation;
      uniform float u_visualStyle;
      uniform float u_particleOpacity;
      uniform float u_pointScaleSetting;
      uniform float u_palette;
      uniform float u_autoView;
      uniform vec2 u_auraOffset;
      uniform float u_auraScale;
      uniform float u_planetWaveClock;
      uniform float u_musicActive;
      varying vec3 v_color;
      varying float v_alpha;
      varying float v_glow;
      const float TAU = 6.28318530718;
      mat2 rotate2d(float a) {
        float s = sin(a);
        float c = cos(a);
        return mat2(c, -s, s, c);
      }
      vec3 rotateX(vec3 p, float a) {
        float s = sin(a);
        float c = cos(a);
        return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
      }
      vec3 rotateY(vec3 p, float a) {
        float s = sin(a);
        float c = cos(a);
        return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
      }
      vec3 rotateZ(vec3 p, float a) {
        float s = sin(a);
        float c = cos(a);
        return vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z);
      }
      float hash1(float n) {
        return fract(sin(n * 127.1 + 311.7) * 43758.5453123);
      }
      vec3 randomSpherePoint(float seed) {
        float z = hash1(seed + 1.0) * 2.0 - 1.0;
        float a = hash1(seed + 7.0) * TAU;
        float r = sqrt(max(0.0, 1.0 - z * z));
        return normalize(vec3(cos(a) * r, z, sin(a) * r));
      }
      vec3 applyAutoView(vec3 p, float preset, float view) {
        if (view <= 0.001) return p;
        float t = u_time;
        float yaw = 0.0;
        float pitch = 0.0;
        float roll = 0.0;
        if (preset < 0.5) {
          yaw = sin(t * 0.18) * 0.34;
          pitch = sin(t * 0.13 + 1.1) * 0.16;
          roll = sin(t * 0.10 + 0.4) * 0.08;
        } else if (preset < 1.5) {
          pitch = sin(t * 0.16) * 0.30;
          yaw = sin(t * 0.11 + 0.8) * 0.18;
          roll = sin(t * 0.09) * 0.045;
        } else if (preset < 2.5) {
          yaw = t * 0.16 + sin(t * 0.10) * 0.20;
          pitch = sin(t * 0.14 + 0.7) * 0.22;
          roll = sin(t * 0.08) * 0.06;
        } else if (preset < 3.5) {
          yaw = sin(t * 0.13) * 0.18;
          pitch = sin(t * 0.10 + 0.6) * 0.10;
          roll = sin(t * 0.15) * 0.12;
        } else {
          yaw = sin(t * 0.12) * 0.16;
          pitch = sin(t * 0.09 + 1.3) * 0.10;
          roll = sin(t * 0.07) * 0.10;
        }
        p = rotateY(p, yaw * view);
        p = rotateX(p, pitch * view);
        p = rotateZ(p, roll * view);
        return p;
      }
      vec3 paletteColor(float band, float accent, float readable) {
        vec3 c0 = vec3(0.18, 0.88, 1.0);
        vec3 c1 = vec3(1.0, 0.34, 0.68);
        vec3 c2 = vec3(1.0, 0.72, 0.25);
        if (u_palette > 0.5 && u_palette < 1.5) {
          c0 = vec3(0.00, 0.42, 0.66);
          c1 = vec3(0.88, 0.04, 0.36);
          c2 = vec3(0.78, 0.34, 0.02);
        } else if (u_palette > 1.5 && u_palette < 2.5) {
          c0 = vec3(0.38, 0.96, 1.0);
          c1 = vec3(0.50, 0.52, 1.0);
          c2 = vec3(0.58, 1.0, 0.62);
        } else if (u_palette > 2.5 && u_palette < 3.5) {
          c0 = vec3(0.0, 0.95, 1.0);
          c1 = vec3(1.0, 0.06, 0.86);
          c2 = vec3(0.75, 1.0, 0.10);
        } else if (u_palette > 3.5) {
          c0 = vec3(1.0, 0.42, 0.16);
          c1 = vec3(1.0, 0.78, 0.30);
          c2 = vec3(0.98, 0.20, 0.42);
        }
        vec3 base = band < 1.0 ? c0 : (band < 2.0 ? c1 : c2);
        vec3 readableBase = mix(base, vec3(0.0), readable * 0.38);
        return mix(readableBase, c1, clamp(accent, 0.0, 0.72));
      }
      void main() {
        float band = floor(a_seed.z * 3.0);
        float dir = mod(floor(a_seed.w * 10.0), 2.0) * 2.0 - 1.0;
        float rnd = a_seed.w;
        float audio = u_bass * 0.55 + u_mid * 0.30 + u_treble * 0.15;
        float beat = smoothstep(0.18, 0.82, u_bass);
        float angle = a_seed.x * TAU + dir * u_time * (0.18 + band * 0.08);
        float radius = mix(0.10, 0.48, pow(a_seed.y, 0.62));
        vec3 world = vec3(0.0);
        float styleAlpha = 1.0;
        float styleSize = 1.0;
        float styleGlow = 0.0;
        float deformation = 0.0;
        if (u_visualStyle < 0.5) {
          float arm = floor(rnd * 4.0);
          float swirl = angle * 1.62 + arm * 1.50 + u_time * (0.10 + u_mid * 0.24);
          float armWave = sin(swirl * 2.0 + a_seed.y * 8.0 + u_time * 0.55) * (0.018 + u_mid * 0.040);
          radius += armWave + (u_bass * 0.115 + beat * 0.070) * u_intensity;
          float layer = (rnd - 0.5) * 0.58;
          world = vec3(cos(swirl) * radius, sin(swirl) * radius * 0.62, layer);
          world.xy += vec2(cos(angle * 3.0), sin(angle * 2.0)) * (0.012 + u_treble * 0.035);
          world = rotateY(world, u_time * 0.10 + u_mid * 0.18);
          styleSize = 0.72 + smoothstep(-0.34, 0.38, world.z) * 0.44;
          deformation = abs(armWave) + u_treble * 0.05;
        } else if (u_visualStyle < 1.5) {
          float ring = floor(a_seed.y * 12.0) / 12.0;
          radius = mix(0.15, 0.52, ring + fract(a_seed.y * 12.0) * 0.045);
          float groove = sin(radius * 96.0 + u_time * (1.0 + u_mid)) * (0.004 + u_mid * 0.012);
          float rim = smoothstep(0.78, 1.0, a_seed.y);
          radius += groove + (u_bass * 0.085 + beat * 0.060 * rim) * u_intensity;
          float spin = angle + u_time * (0.24 + u_bass * 0.24);
          world = vec3(cos(spin) * radius, sin(spin) * radius * 0.58, groove * 4.2 + rim * beat * 0.125);
          world = rotateX(world, -0.55);
          styleAlpha = 0.78 + rim * 0.48 + u_treble * rim * 0.30;
          styleSize = 0.60 + rim * 0.34 + beat * rim * 0.30;
          deformation = abs(groove) * 4.0 + rim * beat * 0.10;
        } else if (u_visualStyle < 2.5) {
          float theta = a_seed.x * TAU + u_time * 0.20;
          float phi = acos(1.0 - 2.0 * clamp(a_seed.y, 0.02, 0.98));
          vec3 normal = normalize(vec3(
            cos(theta) * sin(phi),
            cos(phi),
            sin(theta) * sin(phi)
          ));
          float waveClock = u_planetWaveClock;
          float waveIndex = floor(waveClock);
          float waveProgress = fract(waveClock);
          vec3 source = randomSpherePoint(waveIndex);
          vec3 antipode = -source;
          float sourceDistance = acos(clamp(dot(normal, source), -1.0, 1.0));
          float antipodeDistance = acos(clamp(dot(normal, antipode), -1.0, 1.0));
          float waveFront = waveProgress * 3.1415926;
          float wavePhase = sourceDistance - waveFront;
          float primaryWave = exp(-(wavePhase * wavePhase) / 0.070);
          float trailingTrough = -0.32 * exp(-((wavePhase + 0.26) * (wavePhase + 0.26)) / 0.090);
          float cycleFade = smoothstep(0.02, 0.16, waveProgress) * (1.0 - smoothstep(0.88, 0.99, waveProgress));
          float antipodeSoftness = 1.0 - exp(-(antipodeDistance * antipodeDistance) / 0.050) * smoothstep(0.86, 1.0, waveProgress) * 0.28;
          float waveAmplitude = 0.030 + u_bass * 0.014 + u_mid * 0.010;
          float travelWave = (primaryWave + trailingTrough) * waveAmplitude * cycleFade * antipodeSoftness;
          float latWave = sin((phi - 1.5707963) * 5.0 - waveClock * 0.75) * 0.006;
          float ringPulse = primaryWave * cycleFade * (beat * 0.018 + u_bass * 0.010);
          float bassBreath = (u_bass * 0.030 + beat * 0.020) * u_intensity;
          float trebleShimmer = sin(theta * 13.0 + phi * 11.0 + u_time * (1.4 + u_treble * 0.9)) * u_treble * 0.008;
          deformation = bassBreath + travelWave * u_intensity + latWave * u_intensity + ringPulse + trebleShimmer;
          world = normal * (0.365 + deformation);
          world = rotateY(world, u_time * 0.22 + u_mid * 0.12);
          world = rotateX(world, -0.20 + sin(u_time * 0.17) * 0.08);
          float planetWake = mix(0.50, 0.88, u_musicActive);
          float waveGlow = primaryWave * cycleFade * (0.48 + u_mid * 0.20 + u_treble * 0.36);
          styleAlpha = planetWake + waveGlow * 0.32;
          styleGlow = waveGlow * 1.35 + u_musicActive * 0.28;
          styleSize = 0.58 + ringPulse * 0.65 + smoothstep(-0.22, 0.32, world.z) * 0.34;
        } else if (u_visualStyle < 3.5) {
          float depth = fract(a_seed.y - u_time * (0.08 + u_bass * 0.075));
          float tunnelRadius = mix(0.09, 0.50, depth);
          float pulseRing = exp(-pow((depth - fract(u_time * 0.52)) / 0.10, 2.0)) * (beat * 1.30 + u_bass * 0.70);
          float tunnelAngle = a_seed.x * TAU * 1.55 + depth * 5.8 + u_time * (0.18 + u_mid * 0.25);
          tunnelRadius += sin(tunnelAngle * 3.0 + u_time * 1.4) * (0.010 + u_mid * 0.025);
          tunnelRadius += pulseRing * 0.075 * u_intensity;
          world = vec3(cos(tunnelAngle) * tunnelRadius, sin(tunnelAngle) * tunnelRadius * 0.62, depth * 1.15 - 0.58);
          styleAlpha = smoothstep(0.02, 0.28, depth) * (1.0 - smoothstep(0.90, 1.0, depth));
          styleSize = mix(0.40, 1.18, depth) + pulseRing * 0.42;
          deformation = pulseRing * 0.12 + u_mid * 0.03;
        } else {
          float lane = floor(a_seed.z * 5.0);
          float x = (a_seed.x - 0.5) * 0.98;
          float y = (lane - 2.0) * 0.075;
          y += sin(x * 9.0 + u_time * (0.72 + lane * 0.08) + rnd * 4.0) * (0.08 + u_mid * 0.09);
          y += sin(x * 17.0 - u_time * 0.46) * 0.025;
          x += sin(u_time * 0.32 + a_seed.y * 9.0) * 0.035;
          float z = sin(x * 5.0 + lane + u_time * 0.22) * 0.34 + (rnd - 0.5) * 0.14;
          world = vec3(x, y, z) * (0.88 + u_bass * 0.22 + beat * 0.08);
          world.xy += vec2(sin(z * 4.0 + u_time * 0.25), cos(z * 3.0 + u_time * 0.18)) * u_mid * 0.060;
          styleAlpha = 0.74 + u_treble * 0.52;
          styleSize = 0.62 + u_treble * 0.55;
          deformation = u_mid * 0.05 + u_treble * 0.04;
        }
        world.xy += vec2(cos(angle * (2.0 + band)), sin(angle * 1.7)) * (0.004 + u_treble * 0.012) * u_intensity;
        world = applyAutoView(world, u_visualStyle, u_autoView);
        float perspective = 1.0 / max(0.72, 1.34 - world.z * 0.34);
        vec2 pos = world.xy * perspective;
        pos.x /= max(u_aspect, 0.75);
        pos = pos * u_auraScale + u_auraOffset;
        gl_Position = vec4(pos, 0.0, 1.0);
        float pointBase = 1.15 + rnd * 3.15 + band * 0.22;
        float planetPointBoost = u_visualStyle > 1.5 && u_visualStyle < 2.5 ? abs(deformation) * 0.75 : abs(deformation) * 2.4;
        gl_PointSize = pointBase * u_pixelRatio * u_pointScaleSetting * styleSize * perspective * (0.88 + u_intensity * 0.22 + audio * 1.18 + beat * 0.42 + planetPointBoost);
        float readable = smoothstep(0.45, 1.0, u_backgroundAdaptation);
        v_color = paletteColor(band, clamp((u_state - 0.8) * 0.48 + u_mid * 0.26 + beat * 0.18, 0.0, 0.78), readable);
        float depthAlpha = mix(0.62, 1.16, smoothstep(-0.48, 0.48, world.z));
        float audioAlpha = u_visualStyle > 1.5 && u_visualStyle < 2.5 ? u_musicActive * 0.24 : (u_treble * 0.32 + u_bass * 0.30 + beat * 0.18);
        float audioGlow = u_visualStyle > 1.5 && u_visualStyle < 2.5 ? u_musicActive * 0.28 : (audio * 0.70 + beat * 0.46);
        v_alpha = (0.28 + audioAlpha + a_seed.y * 0.12 + abs(deformation) * 0.92) * styleAlpha * depthAlpha * u_particleOpacity;
        v_glow = 0.68 + audioGlow + abs(deformation) * 1.8 + styleGlow;
      }
    `);
    const fragment = createShader(gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform float u_glowStrength;
      varying vec3 v_color;
      varying float v_alpha;
      varying float v_glow;
      void main() {
        vec2 p = gl_PointCoord - vec2(0.5);
        float d = length(p);
        float core = smoothstep(0.18, 0.0, d);
        float glow = smoothstep(0.5, 0.0, d);
        float alpha = (core * 0.86 + glow * 0.30 * u_glowStrength * v_glow) * v_alpha;
        if (alpha < 0.02) discard;
        gl_FragColor = vec4(v_color, alpha);
      }
    `);
    const nextProgram = gl.createProgram();
    gl.attachShader(nextProgram, vertex);
    gl.attachShader(nextProgram, fragment);
    gl.linkProgram(nextProgram);
    if (!gl.getProgramParameter(nextProgram, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(nextProgram) || "program link failed");
    }
    return nextProgram;
  }

  function ensureGl() {
    if (gl && program) return true;
    gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) return false;
    try {
      program = createProgram();
      seedBuffer = gl.createBuffer();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.disable(gl.DEPTH_TEST);
      rebuildParticles();
      return true;
    } catch (err) {
      console.warn("music aura: WebGL setup failed", err);
      gl = null;
      program = null;
      return false;
    }
  }

  function particleTargetCount() {
    let base = 430;
    if (settings.performance === "eco") base = 260;
    if (settings.performance === "high") base = 760;
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    if (settings.performance === "auto") base = dpr > 1.5 ? 540 : 430;
    base = settings.visualStyle === "planet" ? Math.round(base * 1.55) : base;
    return Math.max(120, Math.round(base * settings.particleDensity));
  }

  function rebuildParticles() {
    if (!gl || !seedBuffer) return;
    const count = particleTargetCount();
    if (count === seedCount) return;
    seedCount = count;
    const data = new Float32Array(seedCount * 4);
    for (let i = 0; i < seedCount; i += 1) {
      const r = i / Math.max(1, seedCount - 1);
      data[i * 4] = (r * 7.61803398875) % 1;
      data[i * 4 + 1] = Math.pow(((i * 37) % seedCount) / seedCount, 0.72);
      data[i * 4 + 2] = (i % 3) / 3 + 0.04;
      data[i * 4 + 3] = ((i * 97) % 251) / 251;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, root.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (gl) gl.viewport(0, 0, width, height);
    return { width, height, dpr };
  }

  function intensityValue() {
    if (settings.intensity === "subtle") return 0.72;
    if (settings.intensity === "stage") return 1.42;
    return 1.08;
  }

  function backgroundAdaptationValue() {
    if (settings.backgroundAdaptation === "dark") return 0;
    if (settings.backgroundAdaptation === "light") return 1;
    if (settings.backgroundAdaptation === "contrast") return 1;
    return 0.75;
  }

  function visualStyleValue() {
    if (settings.visualStyle === "vinyl") return 1;
    if (settings.visualStyle === "planet") return 2;
    if (settings.visualStyle === "tunnel") return 3;
    if (settings.visualStyle === "aurora") return 4;
    return 0;
  }

  function paletteValue() {
    if (settings.particlePalette === "contrast") return 1;
    if (settings.particlePalette === "aurora") return 2;
    if (settings.particlePalette === "neon") return 3;
    if (settings.particlePalette === "warm") return 4;
    return 0;
  }

  function autoViewValue() {
    if (settings.autoViewMode === "off") return 0;
    if (settings.autoViewMode === "subtle") return 0.55;
    if (settings.autoViewMode === "strong") return 1.35;
    return 1;
  }

  function finiteNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  function edgePressure(gap, band) {
    if (!Number.isFinite(gap) || !Number.isFinite(band) || band <= 0) return 0;
    return clamp(1 - gap / band, 0, 1, 0);
  }

  function themePlacement() {
    const byTheme = settings.auraPlacementByTheme && typeof settings.auraPlacementByTheme === "object"
      ? settings.auraPlacementByTheme
      : {};
    const specific = currentThemeId && byTheme[currentThemeId] && typeof byTheme[currentThemeId] === "object"
      ? byTheme[currentThemeId]
      : null;
    return {
      offsetX: Number.isFinite(settings.auraOffsetX) ? settings.auraOffsetX : 0,
      offsetY: Number.isFinite(settings.auraOffsetY) ? settings.auraOffsetY : 0,
      scale: Number.isFinite(settings.auraScale) ? settings.auraScale : 1,
      themeOffsetX: specific && Number.isFinite(specific.offsetX) ? specific.offsetX : 0,
      themeOffsetY: specific && Number.isFinite(specific.offsetY) ? specific.offsetY : 0,
      themeScale: specific && Number.isFinite(specific.scale) ? specific.scale : 1,
    };
  }

  function computeAuraPlacement() {
    const rect = canvas.getBoundingClientRect();
    const viewportWidth = Math.max(1, finiteNumber(root.innerWidth, rect.width || 1));
    const viewportHeight = Math.max(1, finiteNumber(root.innerHeight, rect.height || 1));
    const screenInfo = root.screen || {};
    const screenX = finiteNumber(root.screenX, finiteNumber(root.screenLeft, 0));
    const screenY = finiteNumber(root.screenY, finiteNumber(root.screenTop, 0));
    const availLeft = finiteNumber(screenInfo.availLeft, 0);
    const availTop = finiteNumber(screenInfo.availTop, 0);
    const availWidth = Math.max(1, finiteNumber(screenInfo.availWidth, viewportWidth));
    const availHeight = Math.max(1, finiteNumber(screenInfo.availHeight, viewportHeight));
    const edgeBandX = Math.max(24, viewportWidth * 0.18);
    const edgeBandY = Math.max(24, viewportHeight * 0.18);
    const leftPressure = edgePressure(screenX - availLeft, edgeBandX);
    const rightPressure = edgePressure(availLeft + availWidth - (screenX + viewportWidth), edgeBandX);
    const topPressure = edgePressure(screenY - availTop, edgeBandY);
    const bottomPressure = edgePressure(availTop + availHeight - (screenY + viewportHeight), edgeBandY);
    const minSide = Math.min(rect.width || viewportWidth, rect.height || viewportHeight);
    const largePetBias = clamp((minSide - 300) / 260, 0, 1, 0);
    const edgeMax = Math.max(leftPressure, rightPressure, topPressure, bottomPressure);
    const manual = themePlacement();

    return {
      x: clamp(0.10 + leftPressure * 0.24 - rightPressure * 0.24 + manual.offsetX + manual.themeOffsetX, -0.5, 0.5, 0.10),
      y: clamp(0.09 + bottomPressure * 0.22 - topPressure * 0.18 - largePetBias * 0.04 + manual.offsetY + manual.themeOffsetY, -0.42, 0.48, 0.09),
      scale: clamp((1.02 - largePetBias * 0.06 - edgeMax * 0.10) * manual.scale * manual.themeScale, 0.62, 1.45, 1.0),
    };
  }

  function stateEnergy() {
    if (!settings.stateReactive) return 0.76;
    return STATE_ENERGY[currentState] || (String(currentState || "").startsWith("mini-") ? 0.46 : 0.86);
  }

  function averageBand(startRatio, endRatio) {
    if (!frequencyData || !frequencyData.length) return 0;
    const start = Math.max(0, Math.floor(frequencyData.length * startRatio));
    const end = Math.max(start + 1, Math.floor(frequencyData.length * endRatio));
    let total = 0;
    for (let i = start; i < end; i += 1) total += frequencyData[i] || 0;
    return total / ((end - start) * 255);
  }

  function sampleAudio() {
    if (analyser && frequencyData && !audio.paused) {
      analyser.getByteFrequencyData(frequencyData);
      bass += (averageBand(0.00, 0.10) - bass) * 0.28;
      mid += (averageBand(0.10, 0.42) - mid) * 0.22;
      treble += (averageBand(0.42, 0.86) - treble) * 0.18;
      return;
    }
    bass *= 0.9;
    mid *= 0.88;
    treble *= 0.86;
  }

  function shouldShowVisual() {
    return settings.enabled
      && settings.visualEnabled
      && (!miniMode || settings.miniModeEnabled)
      && (settings.particlesAlwaysOn || !audio.paused || bass + mid + treble > 0.08);
  }

  function syncCanvasVisibility({ schedule = true } = {}) {
    const visible = shouldShowVisual();
    if (visible !== lastVisible) {
      lastVisible = visible;
      canvas.classList.toggle("active", visible);
    }
    if (schedule && visible) startVisualLoop();
  }

  function renderFrame(now) {
    rafId = null;
    sampleAudio();
    reportPlaybackProgress();
    syncCanvasVisibility({ schedule: false });
    if (!lastVisible) {
      lastVisualFrameAt = 0;
      if (gl) gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const elapsed = lastVisualFrameAt
      ? Math.min(0.05, Math.max(0, (now - lastVisualFrameAt) / 1000))
      : 1 / 60;
    lastVisualFrameAt = now;
    const bassSpeed = bass * 0.22;
    const midSpeed = mid * 1.05;
    const trebleSpeed = treble * 0.68;
    const planetWaveSpeed = clamp(0.10 + bassSpeed + midSpeed + trebleSpeed, 0.08, 1.55, 0.10);
    planetWaveClock += elapsed * planetWaveSpeed;
    if (planetWaveClock > 10000) planetWaveClock %= 1000;
    if (!ensureGl()) return;
    const size = resizeCanvas();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
    const seedLoc = gl.getAttribLocation(program, "a_seed");
    gl.enableVertexAttribArray(seedLoc);
    gl.vertexAttribPointer(seedLoc, 4, gl.FLOAT, false, 0, 0);
    const musicActive = !audio.paused && !audio.ended ? 1 : 0;
    gl.uniform1f(gl.getUniformLocation(program, "u_time"), (now - startedAt) / 1000);
    gl.uniform1f(gl.getUniformLocation(program, "u_planetWaveClock"), planetWaveClock);
    gl.uniform1f(gl.getUniformLocation(program, "u_musicActive"), musicActive);
    gl.uniform1f(gl.getUniformLocation(program, "u_bass"), bass);
    gl.uniform1f(gl.getUniformLocation(program, "u_mid"), mid);
    gl.uniform1f(gl.getUniformLocation(program, "u_treble"), treble);
    gl.uniform1f(gl.getUniformLocation(program, "u_state"), stateEnergy());
    gl.uniform1f(gl.getUniformLocation(program, "u_intensity"), intensityValue());
    gl.uniform1f(gl.getUniformLocation(program, "u_aspect"), size.width / Math.max(1, size.height));
    gl.uniform1f(gl.getUniformLocation(program, "u_pixelRatio"), size.dpr);
    gl.uniform1f(gl.getUniformLocation(program, "u_backgroundAdaptation"), backgroundAdaptationValue());
    gl.uniform1f(gl.getUniformLocation(program, "u_visualStyle"), visualStyleValue());
    gl.uniform1f(gl.getUniformLocation(program, "u_particleOpacity"), settings.particleOpacity);
    gl.uniform1f(gl.getUniformLocation(program, "u_glowStrength"), settings.glowStrength);
    gl.uniform1f(gl.getUniformLocation(program, "u_pointScaleSetting"), settings.pointScale);
    gl.uniform1f(gl.getUniformLocation(program, "u_palette"), paletteValue());
    gl.uniform1f(gl.getUniformLocation(program, "u_autoView"), autoViewValue());
    const auraPlacement = computeAuraPlacement();
    gl.uniform2f(gl.getUniformLocation(program, "u_auraOffset"), auraPlacement.x, auraPlacement.y);
    gl.uniform1f(gl.getUniformLocation(program, "u_auraScale"), auraPlacement.scale);
    gl.drawArrays(gl.POINTS, 0, seedCount);
    rafId = requestAnimationFrame(renderFrame);
  }

  function startVisualLoop() {
    if (rafId || !shouldShowVisual()) return;
    rafId = requestAnimationFrame(renderFrame);
  }

  audio.addEventListener("play", () => {
    reportStatus("");
    startVisualLoop();
  });
  audio.addEventListener("timeupdate", reportPlaybackProgress);
  audio.addEventListener("pause", () => {
    reportStatus("");
    syncCanvasVisibility();
  });
  audio.addEventListener("ended", () => {
    reportStatus("");
    nextTrack();
  });
  audio.addEventListener("error", () => {
    const message = audio.error ? `Audio error ${audio.error.code}` : "Audio playback error";
    reportStatus(message);
    nextTrack();
  });
  root.addEventListener("pagehide", () => reportStatus());
  root.addEventListener("beforeunload", () => reportStatus());

  if (typeof api.onStateChange === "function") {
    api.onStateChange((state) => {
      currentState = state || "idle";
      syncCanvasVisibility();
    });
  }
  if (typeof api.onMiniModeChange === "function") {
    api.onMiniModeChange((enabled) => {
      miniMode = !!enabled;
      syncCanvasVisibility();
    });
  }
  if (typeof api.onThemeConfig === "function") {
    api.onThemeConfig((config) => {
      currentThemeId = themeIdFromConfig(config);
    });
  }
  if (typeof api.onMusicAuraSettings === "function") {
    api.onMusicAuraSettings(applySettings);
  }
  if (typeof api.onMusicAuraLibrary === "function") {
    api.onMusicAuraLibrary(applyLibrary);
  }
  if (typeof api.onMusicAuraCommand === "function") {
    api.onMusicAuraCommand(handleCommand);
  }

  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      if (gl) resizeCanvas();
    });
    observer.observe(canvas);
  }

  if (typeof api.getMusicAuraBootstrap === "function") {
    api.getMusicAuraBootstrap().then((bootstrap) => {
      applySettings(bootstrap && bootstrap.settings);
      applyLibrary(bootstrap && bootstrap.library);
      const status = bootstrap && bootstrap.status;
      let restoredPlaying = false;
      if (status && status.track && Array.isArray(tracks)) {
        const idx = tracks.findIndex((track) => track && track.id === status.track.id);
        if (idx >= 0) currentIndex = idx;
        if (settings.enabled && status.playing === true) {
          restoredPlaying = true;
          playIndex(idx >= 0 ? idx : currentIndex, { startTime: status.currentTime });
        }
      }
      if (!restoredPlaying && settings.enabled && settings.autoStart && tracks.length) {
        playIndex(currentIndex >= 0 ? currentIndex : 0);
      }
    }).catch((err) => {
      console.warn("music aura: bootstrap failed", err);
    });
  }
})(window);
