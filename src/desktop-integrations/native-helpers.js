"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { execFile } = require("node:child_process");
const SOURCES = [
  "build-native.ps1",
  "library-native.cs",
  "desktop-lyrics.cs",
  "qqmusic-worker.ps1",
  "audio-session.cs",
];
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
async function prepareNativeHelpers({
  sourceRoot = path.join(__dirname, "qqmusic"),
  storageRoot,
  platform = process.platform,
  arch = process.arch,
  run = execFile,
} = {}) {
  if (platform !== "win32" || arch !== "x64")
    throw Error("QQ Music controls currently require Windows x64");
  const inputs = Object.fromEntries(
    SOURCES.map((name) => [
      name,
      hash(fs.readFileSync(path.join(sourceRoot, name))),
    ]),
  );
  const generation = hash(
      Buffer.from(JSON.stringify({ inputs, platform, arch })),
    ).slice(0, 24),
    root = path.join(storageRoot, "native", generation),
    marker = path.join(root, "clawd-qqmusic-native.json");
  if (fs.existsSync(root)) {
    const record = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (
      record.owner !== "clawd.qqmusic.native.v1" ||
      record.generation !== generation
    )
      throw Error("QQ Music helper ownership is invalid");
    for (const [name, digest] of Object.entries({
      ...inputs,
      ...record.outputs,
    }))
      if (hash(fs.readFileSync(path.join(root, name))) !== digest)
        throw Error(
          "QQ Music helpers changed; choose a new cache directory before rebuilding",
        );
    if (
      !record.outputs?.["library-native.exe"] ||
      !record.outputs?.["desktop-lyrics.exe"]
    )
      throw Error("QQ Music helpers are incomplete");
    return root;
  }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(root), "build-"));
  for (const name of SOURCES)
    fs.copyFileSync(path.join(sourceRoot, name), path.join(stage, name));
  await new Promise((resolve, reject) =>
    run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(stage, "build-native.ps1"),
        "-OutputDirectory",
        stage,
      ],
      { windowsHide: true, timeout: 60000, maxBuffer: 65536 },
      (error) =>
        error
          ? reject(
              Error(
                "Could not build QQ Music helpers. Windows PowerShell and .NET Framework 4.x are required.",
              ),
            )
          : resolve(),
    ),
  );
  const outputs = Object.fromEntries(
    ["library-native.exe", "desktop-lyrics.exe"].map((name) => [
      name,
      hash(fs.readFileSync(path.join(stage, name))),
    ]),
  );
  fs.writeFileSync(
    path.join(stage, "clawd-qqmusic-native.json"),
    JSON.stringify({
      owner: "clawd.qqmusic.native.v1",
      generation,
      inputs,
      outputs,
    }),
  );
  fs.renameSync(stage, root);
  return root;
}
module.exports = { prepareNativeHelpers };
