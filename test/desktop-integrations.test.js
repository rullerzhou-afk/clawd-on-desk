"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  crypto = require("node:crypto"),
  { EventEmitter } = require("node:events");
const {
  normalizeDesktopIntegrations,
  validateDesktopIntegrations,
} = require("../src/desktop-integrations/settings");
const {
  createQuestionServer,
  validateQuestions,
  collectAnswers,
} = require("../src/desktop-integrations/questions");
const { ask } = require("../hooks/desktop-question-mcp.cjs");

test("question text cannot mutate the answer object's prototype", () => {
  const answer = collectAnswers(
    [
      {
        question: "__proto__",
        options: [{ label: "Blue" }],
        multiSelect: false,
      },
    ],
    [{ selected: [0], other: "" }],
  );
  assert.equal(Object.getPrototypeOf(answer), Object.prototype);
  assert.equal(Object.hasOwn(answer, "__proto__"), true);
  assert.equal(JSON.parse(JSON.stringify(answer)).__proto__, "Blue");
});
function temporary() {
  const root = fs.mkdtempSync(
    path.join(__dirname, "tmp-desktop-integrations-"),
  );
  return {
    root,
    close() {
      assert.equal(path.dirname(root), __dirname);
      assert.ok(path.basename(root).startsWith("tmp-desktop-integrations-"));
      fs.rmSync(root, { recursive: true });
    },
  };
}
const input = {
  source: "fixture MCP",
  questions: [
    {
      question: "Choose tools",
      multiSelect: true,
      options: [
        { label: "Search", description: "Local only" },
        { label: "Export" },
      ],
    },
  ],
};
test("desktop settings default off and reject hidden commands, unsafe paths and malformed values", () => {
  const defaults = normalizeDesktopIntegrations({});
  assert.equal(defaults.questionsEnabled, false);
  assert.equal(defaults.qqmusicEnabled, false);
  assert.equal(defaults.cockpitCheckinEnabled, false);
  assert.equal(defaults.gatewayEnabled, false);
  assert.deepEqual(defaults.apps, []);
  for (const value of [
    { questionsEnabled: 1 },
    { gatewayPort: 65536 },
    { qqmusicExecutable: "relative.exe" },
    { cockpitDataRoot: "relative" },
    { shellCommand: "whoami" },
    { apps: [{ id: "../bad", name: "App", executable: process.execPath }] },
    { qqmusicPanelSize: { width: 100, height: 100 } },
  ])
    assert.equal(validateDesktopIntegrations(value).status, "error");
  assert.equal(
    validateDesktopIntegrations({
      ...defaults,
      qqmusicEnabled: true,
      qqmusicExecutable: process.execPath,
      apps: [{ id: "codex", name: "Codex", executable: process.execPath }],
    }).status,
    "ok",
  );
});
test("preferences and the sole settings controller persist opt-in and reversible configuration", () => {
  const prefs = require("../src/prefs"),
    { createSettingsController } = require("../src/settings-controller"),
    f = temporary();
  try {
    const file = path.join(f.root, "prefs.json"),
      controller = createSettingsController({ prefsPath: file });
    const value = {
      ...controller.get("desktopIntegrations"),
      questionsEnabled: true,
      cockpitCheckinEnabled: true,
    };
    assert.equal(
      controller.applyUpdate("desktopIntegrations", value).status,
      "ok",
    );
    assert.equal(
      prefs.load(file).snapshot.desktopIntegrations.questionsEnabled,
      true,
    );
    assert.equal(
      controller.applyUpdate("desktopIntegrations", {
        ...value,
        questionsEnabled: "yes",
      }).status,
      "error",
    );
    assert.equal(
      controller.applyUpdate("desktopIntegrations", {
        ...value,
        questionsEnabled: false,
        cockpitCheckinEnabled: false,
      }).status,
      "ok",
    );
    assert.equal(
      prefs.load(file).snapshot.desktopIntegrations.questionsEnabled,
      false,
    );
    controller.dispose();
  } finally {
    f.close();
  }
});
test("question schema keeps descriptions and custom multiline answers without inventing a selection", () => {
  assert.deepEqual(validateQuestions(input), {
    ...input,
    questions: [
      {
        ...input.questions[0],
        header: "",
        options: [
          { label: "Search", description: "Local only" },
          { label: "Export", description: "" },
        ],
      },
    ],
  });
  const q = validateQuestions(input).questions;
  assert.deepEqual(
    collectAnswers(q, [{ selected: [0], other: "  custom\nnext line  " }]),
    { "Choose tools": "Search,   custom\nnext line  " },
  );
  assert.throws(() => collectAnswers(q, [{ selected: [], other: "" }]));
  assert.throws(() =>
    validateQuestions({
      ...input,
      questions: [input.questions[0], input.questions[0]],
    }),
  );
  assert.throws(() =>
    collectAnswers(
      [
        {
          question: "Single",
          multiSelect: false,
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
      [{ selected: [0, 1], other: "" }],
    ),
  );
});
test("real local MCP transport waits for the actual answer and preserves complete questions", async () => {
  const f = temporary(),
    discoveryPath = path.join(f.root, "endpoint.json");
  let presented, resolvePresented;
  const ready = new Promise((resolve) => (resolvePresented = resolve));
  const server = await createQuestionServer({
    discoveryPath,
    isEnabled: () => true,
    present: (question, decisions) => {
      presented = { question, decisions };
      resolvePresented();
      return { close() {} };
    },
  });
  try {
    let completed = false;
    const pending = ask(input.questions, {
      endpointFile: discoveryPath,
      sourceName: input.source,
    }).then((answer) => {
      completed = true;
      return answer;
    });
    await ready;
    assert.equal(completed, false);
    assert.equal(
      presented.question.questions[0].options[0].description,
      "Local only",
    );
    presented.decisions.answer([{ selected: [0, 1], other: "" }]);
    assert.deepEqual(await pending, {
      status: "answered",
      answers: { "Choose tools": "Search, Export" },
    });
  } finally {
    await server.dispose();
    assert.equal(fs.existsSync(discoveryPath), false);
    f.close();
  }
});
test("cancellation, disabled policy and timeouts never produce an answer", async () => {
  for (const kind of ["cancel", "disabled", "timeout"]) {
    const f = temporary(),
      discoveryPath = path.join(f.root, "endpoint.json");
    let enabled = kind !== "disabled";
    const server = await createQuestionServer({
      discoveryPath,
      isEnabled: () => enabled,
      timeoutMs: 20,
      present: (_question, decisions) => {
        if (kind === "cancel") setImmediate(decisions.cancel);
        return { close() {} };
      },
    });
    try {
      const value = await ask(input.questions, {
        endpointFile: discoveryPath,
        timeoutMs: 1000,
      });
      assert.equal(value.status, "cancelled");
      assert.equal(value.answers, undefined);
    } finally {
      await server.dispose();
      f.close();
    }
  }
});

test("a window cleanup error cannot orphan the user's submitted answer", async () => {
  const f = temporary(),
    discoveryPath = path.join(f.root, "endpoint.json");
  const server = await createQuestionServer({
    discoveryPath,
    isEnabled: () => true,
    present(_input, decisions) {
      setImmediate(() => decisions.answer([{ selected: [1], other: "" }]));
      return {
        close() {
          throw Error("window context was destroyed");
        },
      };
    },
  });
  try {
    const result = await ask(input.questions, {
      endpointFile: discoveryPath,
      timeoutMs: 1000,
    });
    assert.deepEqual(result, {
      status: "answered",
      answers: { "Choose tools": "Export" },
    });
  } finally {
    await server.dispose();
    f.close();
  }
});
test("loopback questions require the private endpoint token; browser requests are rejected", async () => {
  const f = temporary(),
    discoveryPath = path.join(f.root, "endpoint.json"),
    server = await createQuestionServer({
      discoveryPath,
      isEnabled: () => true,
      present: () => assert.fail("must reject"),
    });
  async function post(headers) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        server.endpoint.url,
        { method: "POST", headers },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(input));
    });
  }
  try {
    assert.equal(await post({}), 403);
    assert.equal(
      await post({
        Authorization: "Bearer " + server.endpoint.token,
        Origin: "https://example.invalid",
      }),
      403,
    );
  } finally {
    await server.dispose();
    f.close();
  }
});
test("disabling the integration while an answer is pending cancels it; shutdown preserves a replacement endpoint", async () => {
  const f = temporary(),
    discoveryPath = path.join(f.root, "endpoint.json");
  let enabled = true,
    decisions,
    ready;
  const shown = new Promise((resolve) => (ready = resolve)),
    server = await createQuestionServer({
      discoveryPath,
      isEnabled: () => enabled,
      present: (_q, d) => {
        decisions = d;
        ready();
        return { close() {} };
      },
    });
  try {
    const request = ask(input.questions, { endpointFile: discoveryPath });
    await shown;
    enabled = false;
    decisions.answer([{ selected: [0], other: "" }]);
    assert.equal((await request).status, "cancelled");
    fs.writeFileSync(discoveryPath, JSON.stringify({ token: "replacement" }));
    await server.dispose();
    assert.equal(
      JSON.parse(fs.readFileSync(discoveryPath)).token,
      "replacement",
    );
  } finally {
    f.close();
  }
});
test("desktop IPC authenticates the owner main frame and disabling remains a controller write", async () => {
  const {
      createDesktopIntegrations,
    } = require("../src/desktop-integrations/runtime"),
    f = temporary(),
    handlers = new Map();
  let config = normalizeDesktopIntegrations({}),
    callback,
    saved = 0;
  const app = new EventEmitter();
  app.getPath = () => f.root;
  app.whenReady = () => Promise.resolve();
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = { mainFrame: {}, setWindowOpenHandler() {}, on() {} };
      Window.latest = this;
    }
    setMenu() {}
    once() {}
    loadFile() {}
    isDestroyed() {
      return false;
    }
    show() {}
    focus() {}
    destroy() {}
  }
  const runtime = createDesktopIntegrations(
    {
      lang: "en",
      getDesktopIntegrationSettings: () => config,
      saveDesktopIntegrationSettings: (value) => {
        saved++;
        config = value;
        callback?.();
        return { status: "ok" };
      },
      subscribeDesktopIntegrationSettings: (fn) => {
        callback = fn;
        return () => {};
      },
      desktopIntegrationSettingsAvailable: () => true,
    },
    {
      electron: {
        app,
        BrowserWindow: Window,
        ipcMain: {
          handle: (name, fn) => handlers.set(name, fn),
          removeHandler: (name) => handlers.delete(name),
        },
        dialog: {},
        shell: {},
        net: {},
        clipboard: { writeText() {} },
      },
    },
  );
  try {
    runtime.showSettings();
    const win = Window.latest,
      handler = handlers.get("desktop-integrations:settings");
    assert.equal(
      (
        await handler(
          { sender: win.webContents, senderFrame: {} },
          { action: "save", value: config },
        )
      ).status,
      "error",
    );
    assert.equal(saved, 0);
    assert.equal(
      (
        await handler(
          { sender: win.webContents, senderFrame: win.webContents.mainFrame },
          { action: "save", value: config },
        )
      ).status,
      "ok",
    );
    assert.equal(saved, 1);
  } finally {
    await runtime.dispose();
    assert.equal(handlers.size, 0);
    f.close();
  }
});
