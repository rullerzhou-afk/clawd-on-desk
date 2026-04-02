// CloudBase CLI (tcb / cloudbase) agent configuration
// Process-polling based — no built-in hook system in the CLI
// Monitors tcb/cloudbase process lifecycle and infers state from command args
//
// Design: match longest key first. Keys are plain lowercase substrings tested
// against the full command line, so "fn code download" beats "fn" and
// "storage delete --dir" beats "storage delete".

module.exports = {
  id: "cloudbase-cli",
  name: "CloudBase CLI",
  processNames: {
    win: ["tcb.exe", "cloudbase.exe"],
    mac: ["tcb", "cloudbase"],
    linux: ["tcb", "cloudbase"],
  },
  nodeCommandPatterns: ["@cloudbase/cli", "cloudbase/cli"],
  eventSource: "process-poll",

  // ── CLI sub-command keyword → pet state while running ──
  // Longer keys matched first (sorted at runtime in cloudbase-hook.js)
  //
  // Available pet states (from STATE_SVGS in state.js):
  //   idle        — eyes follow cursor          (clawd-idle-follow.svg)
  //   thinking    — chin-on-hand thinking        (clawd-working-thinking.svg)
  //   working     — typing on keyboard           (clawd-working-typing.svg)
  //   juggling    — multi-ball juggling           (clawd-working-juggling.svg)
  //   carrying    — carrying a box               (clawd-working-carrying.svg)
  //   sweeping    — sweeping / cleanup            (clawd-working-sweeping.svg)
  //   error       — alarmed / error               (clawd-error.svg)
  //   attention   — happy / success               (clawd-happy.svg)
  //   notification — bell notification            (clawd-notification.svg)
  //   sleeping    — zzz                           (clawd-sleeping.svg)

  commandStateMap: {
    // ─── AI full-stack dev (long-running, multi-step) ───
    "ai":                          "juggling",   // tcb ai — AI agent orchestrating multi-tools

    // ─── Login / Auth ───
    "login":                       "notification", // tcb login — auth prompt
    "logout":                      "sweeping",     // tcb logout — cleanup session

    // ─── Environment management ───
    "env list":                    "thinking",   // query env list
    "env rename":                  "working",    // modify env alias
    "env domain":                  "thinking",   // domain config query
    "env login":                   "notification", // env login auth
    "env":                         "thinking",   // fallback env sub-commands

    // ─── Cloud Functions (fn) ───
    "fn deploy":                   "working",    // deploy function
    "fn delete":                   "sweeping",   // delete function — cleanup
    "fn invoke":                   "working",    // invoke function
    "fn list":                     "thinking",   // list functions — query
    "fn detail":                   "thinking",   // get function detail — query
    "fn log":                      "thinking",   // view function logs — reading
    "fn copy":                     "carrying",   // copy function — transfer
    "fn run":                      "working",    // local run function
    "fn code download":            "carrying",   // download function code
    "fn code update":              "working",    // update function code
    "fn config":                   "thinking",   // function config management
    "fn trigger":                  "working",    // trigger management
    "fn publish-version":          "working",    // publish new version
    "fn list-function-versions":   "thinking",   // list versions — query
    "fn set-provisioned":          "working",    // set provisioned concurrency
    "fn get-provisioned":          "thinking",   // get provisioned concurrency — query
    "fn delete-provisioned":       "sweeping",   // delete provisioned config — cleanup
    "fn config-route":             "working",    // set traffic routing
    "fn get-route":                "thinking",   // get traffic routing — query
    "fn layer":                    "working",    // layer management
    "fn":                          "working",    // fallback fn sub-commands

    // ─── Static Hosting ───
    "hosting deploy":              "working",    // deploy static site
    "hosting delete":              "sweeping",   // delete hosting files — cleanup
    "hosting list":                "thinking",   // list hosting files — query
    "hosting detail":              "thinking",   // hosting service info — query
    "hosting download":            "carrying",   // download hosting files
    "hosting":                     "working",    // fallback hosting sub-commands

    // ─── Cloud Storage ───
    "storage upload":              "carrying",   // upload files
    "storage download":            "carrying",   // download files
    "storage delete":              "sweeping",   // delete files — cleanup
    "storage list":                "thinking",   // list files — query
    "storage url":                 "thinking",   // get temp URL — query
    "storage detail":              "thinking",   // file info — query
    "storage get-acl":             "thinking",   // get ACL — query
    "storage set-acl":             "working",    // set ACL — modify
    "storage":                     "carrying",   // fallback storage sub-commands

    // ─── CloudRun (Cloud Hosting) ───
    "cloudrun deploy":             "working",    // deploy cloud run service
    "cloudrun init":               "working",    // init project scaffold
    "cloudrun list":               "thinking",   // list services — query
    "cloudrun download":           "carrying",   // download service code
    "cloudrun delete":             "sweeping",   // delete service — cleanup
    "cloudrun run":                "working",    // local run
    "cloudrun traffic":            "working",    // gray traffic management
    "cloudrun":                    "working",    // fallback cloudrun sub-commands

    // ─── CloudRunFunction (函数型云托管) ───
    "cloudrunfunction deploy":     "working",    // deploy function-type cloud run
    "cloudrunfunction run":        "working",    // local run
    "cloudrunfunction":            "working",    // fallback

    // ─── HTTP Access Service ───
    "service create":              "working",    // create HTTP service
    "service delete":              "sweeping",   // delete HTTP service — cleanup
    "service list":                "thinking",   // list services — query
    "service switch":              "notification", // enable/disable — toggle notice
    "service domain":              "thinking",   // domain management — query
    "service auth":                "notification", // auth config — security notice
    "service":                     "thinking",   // fallback service sub-commands

    // ─── Database (data model) ───
    "db list":                     "thinking",   // list data models — query
    "db pull":                     "carrying",   // pull models from cloud
    "db push":                     "working",    // push models to cloud
    "db diff":                     "thinking",   // diff local vs cloud — analysis
    "db":                          "working",    // fallback db sub-commands

    // ─── Generic fallbacks (single-word, matched last due to short length) ───
    "deploy":                      "working",    // any deploy command
    "delete":                      "sweeping",   // any delete command
    "list":                        "thinking",   // any list command
    "detail":                      "thinking",   // any detail command
    "download":                    "carrying",   // any download command
    "upload":                      "carrying",   // any upload command
    "-h":                          "idle",       // help flag — reading docs
    "--help":                      "idle",       // help flag — reading docs
    "-v":                          "idle",       // version check
    "--version":                   "idle",       // version check
  },

  // Exit code → pet state shown briefly after process ends
  exitStateMap: {
    0: "attention",      // success → happy
    _default: "error",   // failure → alarmed
  },

  capabilities: {
    httpHook: false,
    permissionApproval: false,
    sessionEnd: false,
    subagent: false,
  },

  pollConfig: {
    pollIntervalMs: 2000,    // check every 2s
    exitHoldMs: 3000,        // show exit state for 3s
    processTimeoutMs: 300000, // 5min safety timeout
  },

  pidField: "cloudbase_pid",
};
