// test/agents.test.js — Data integrity tests for agent config modules
// Validates: event mappings → valid states, processNames format, capabilities shape
const { describe, it } = require("node:test");
const assert = require("node:assert");

const path = require("path");
const registry = require("../agents/registry");

// Load default theme for test ctx
const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));
const _defaultTheme = themeLoader.loadTheme("clawd");

// Instantiate state.js to get the authoritative STATE_PRIORITY
const state = require("../src/state.js")({
  theme: _defaultTheme,
  doNotDisturb: false, miniTransitioning: false, miniMode: false,
  mouseOverPet: false, idlePaused: false, forceEyeResend: false,
  eyePauseUntil: 0, mouseStillSince: Date.now(), miniSleepPeeked: false,
  playSound: () => {}, sendToRenderer: () => {}, syncHitWin: () => {},
  sendToHitWin: () => {}, miniPeekIn: () => {}, miniPeekOut: () => {},
  buildContextMenu: () => {}, buildTrayMenu: () => {},
  pendingPermissions: [], resolvePermissionEntry: () => {},
  t: (k) => k, focusTerminalWindow: () => {},
});

const VALID_STATES = new Set(Object.keys(state.STATE_PRIORITY));
// Special internal values that agent maps are allowed to use
const SPECIAL_VALUES = new Set(["codex-turn-end"]);

const REQUIRED_CAPABILITIES = ["httpHook", "permissionApproval", "sessionEnd", "subagent"];

const agents = registry.getAllAgents();

describe("Agent config modules — data integrity", () => {

  // ── Required fields ───────────────────────────────────────────────────────

  for (const agent of agents) {
    describe(agent.id, () => {

      it("has required top-level fields", () => {
        assert.ok(agent.id, "missing id");
        assert.ok(agent.name, "missing name");
        assert.ok(agent.processNames, "missing processNames");
        assert.ok(agent.eventSource, "missing eventSource");
        assert.ok(agent.capabilities, "missing capabilities");
      });

      // ── Event mappings → valid states ───────────────────────────────────

      if (agent.eventMap) {
        it("eventMap values are all valid states", () => {
          for (const [event, target] of Object.entries(agent.eventMap)) {
            if (target === null) continue; // null = intentionally ignored
            assert.ok(
              VALID_STATES.has(target) || SPECIAL_VALUES.has(target),
              `${agent.id}.eventMap["${event}"] = "${target}" is not a valid state. ` +
              `Valid: [${[...VALID_STATES, ...SPECIAL_VALUES].join(", ")}]`
            );
          }
        });
      }

      if (agent.logEventMap) {
        it("logEventMap values are all valid states", () => {
          for (const [event, target] of Object.entries(agent.logEventMap)) {
            if (target === null) continue;
            assert.ok(
              VALID_STATES.has(target) || SPECIAL_VALUES.has(target),
              `${agent.id}.logEventMap["${event}"] = "${target}" is not a valid state. ` +
              `Valid: [${[...VALID_STATES, ...SPECIAL_VALUES].join(", ")}]`
            );
          }
        });
      }

      it("has at least one event map (eventMap or logEventMap)", () => {
        const hasEvents = (agent.eventMap && Object.keys(agent.eventMap).length > 0) ||
                          (agent.logEventMap && Object.keys(agent.logEventMap).length > 0);
        assert.ok(hasEvents, `${agent.id} has no event mappings`);
      });

      // ── processNames format ─────────────────────────────────────────────

      it("win processNames all end with .exe", () => {
        for (const name of agent.processNames.win) {
          assert.ok(name.endsWith(".exe"), `${agent.id} win processName "${name}" should end with .exe`);
        }
      });

      it("mac processNames do not end with .exe", () => {
        for (const name of agent.processNames.mac) {
          assert.ok(!name.endsWith(".exe"), `${agent.id} mac processName "${name}" should not end with .exe`);
        }
      });

      if (agent.processNames.linux) {
        it("linux processNames do not end with .exe", () => {
          for (const name of agent.processNames.linux) {
            assert.ok(!name.endsWith(".exe"), `${agent.id} linux processName "${name}" should not end with .exe`);
          }
        });
      }

      // ── Capabilities shape ──────────────────────────────────────────────

      it("capabilities has all required boolean fields", () => {
        for (const cap of REQUIRED_CAPABILITIES) {
          assert.strictEqual(
            typeof agent.capabilities[cap], "boolean",
            `${agent.id}.capabilities.${cap} should be boolean, got ${typeof agent.capabilities[cap]}`
          );
        }
      });

    });
  }

  // ── Cross-agent: no duplicate IDs ───────────────────────────────────────

  it("all agent IDs are unique", () => {
    const ids = agents.map((a) => a.id);
    const unique = new Set(ids);
    assert.strictEqual(ids.length, unique.size, `Duplicate IDs: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  });

  it("codex has interactiveBubble=true so settings UI renders its bubble sub-toggle", () => {
    const codex = agents.find((a) => a.id === "codex");
    assert.ok(codex);
    assert.strictEqual(codex.capabilities.interactiveBubble, true);
  });

});
