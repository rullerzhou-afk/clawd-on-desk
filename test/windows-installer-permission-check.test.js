const assert = require("node:assert");
const { describe, it } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const NSIS_INCLUDE = path.join(ROOT, "build", "installer.nsh");
const TEMPLATE = path.join(
  ROOT, "node_modules", "app-builder-lib", "templates", "nsis", "include", "installUtil.nsh"
);
const SYNC_MESSAGE = "electron-builder NSIS template changed; resync build/installer.nsh with it";
const PRECHECK = "CLAWD_CHECK_OLD_INSTALL_REMOVABLE";

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
}

function getMacroBody(text, name) {
  const pattern = new RegExp(`^!macro ${name}(?:[ \\t]+[^\\n]*)?\\n([\\s\\S]*?)^!macroend\\b`, "m");
  const macro = text.match(pattern);
  assert.ok(macro, `${SYNC_MESSAGE} (${name})`);
  return macro[1].trim();
}

function normalizeMacroBody(body) {
  return body.split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(";"))
    .join("\n");
}

function assertInstallerOnly(text, pattern) {
  const match = text.match(pattern);
  assert.ok(match, `missing ${pattern}`);
  const guards = [];
  for (const line of text.slice(0, match.index).split("\n")) {
    const directive = line.trim();
    if (/^!if\w*\b/.test(directive)) guards.push(directive);
    else if (directive === "!endif") guards.pop();
  }
  assert.ok(guards.includes("!ifndef BUILD_UNINSTALLER"), `${match[0]} must exclude the uninstaller`);
}

describe("Windows NSIS old-install permission check", () => {
  const installer = readText(NSIS_INCLUDE);
  const template = readText(TEMPLATE);
  const precheck = normalizeMacroBody(getMacroBody(installer, PRECHECK));

  it("issue #882: excludes new macros and the precheck call from the uninstaller", () => {
    for (const name of [PRECHECK, "customUnInstallCheck", "customUnInstallCheckCurrentUser"]) {
      assertInstallerOnly(installer, new RegExp(`^!macro ${name}\\b`, "m"));
    }
    const wrapper = normalizeMacroBody(getMacroBody(installer, "customCheckAppRunning"));
    assertInstallerOnly(wrapper, /^\s*!insertmacro CLAWD_CHECK_OLD_INSTALL_REMOVABLE\b/m);
    assert.match(wrapper, /!insertmacro CLAWD_CHECK_APP_RUNNING\n[\s\S]*!insertmacro CLAWD_CHECK_OLD_INSTALL_REMOVABLE/);
  });

  it("issue #882: reaches directory lookup and permits only the expected exits to done", () => {
    assert.deepStrictEqual(precheck.split("\n").slice(0, 7), [
      "Push $0", "Push $1", "Push $2", "Push $3", "Push $4", "Push $5",
      'ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString',
    ]);
    const doneReferences = precheck.split("\n")
      .filter((line) => line !== "clawd_old_install_removable_done:")
      .filter((line) => /\bclawd_old_install_removable_done\b/.test(line));
    assert.strictEqual(doneReferences.length, 4);
    assert.strictEqual(doneReferences.filter((line) => line.startsWith("Goto ")).length, 3);
    assert.strictEqual(doneReferences.filter((line) => line.startsWith("IfFileExists ")).length, 1);
  });

  it("issue #882: resolves the old directory with the template's registry scope and fallbacks", () => {
    assert.match(precheck, /ReadRegStr \$0 SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}" UninstallString/);
    assert.match(precheck, /\$\{if\} \$0 == ""\n!ifdef UNINSTALL_REGISTRY_KEY_2\nReadRegStr \$0 SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY_2\}" UninstallString\n!endif\n\$\{if\} \$0 == ""\nGoto clawd_old_install_removable_done/);
    assert.match(precheck, /ReadRegStr \$1 SHELL_CONTEXT "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/);
    assert.match(precheck, /\$\{if\} \$1 == ""\n!insertmacro GetInQuotes \$0 "\$0"\n\$\{if\} \$0 != ""\nPush \$0\nCall GetFileParent\nPop \$1\n\$\{endif\}\n\$\{endif\}/);
    assert.match(precheck, /\$\{if\} \$1 == ""\nGoto clawd_old_install_removable_done\n\$\{endif\}\nIfFileExists "\$1\\\*\.\*" 0 clawd_old_install_removable_done/);
    assert.doesNotMatch(precheck, /\$INSTDIR\b|\bHKLM\b|\bHKEY_LOCAL_MACHINE\b/);
    assert.match(template, /^Function GetInQuotes$/m, SYNC_MESSAGE);
    assert.match(template, /^Function GetFileParent$/m, SYNC_MESSAGE);
  });

  it("issue #882: samples four old files with DELETE access, full sharing and OPEN_EXISTING", () => {
    assert.match(precheck, /clawd_old_install_removable_retry:\nStrCpy \$2 0\n\$\{Do\}/);
    assert.match(precheck, /\$\{if\} \$2 == 0\nStrCpy \$3 "\$\{APP_EXECUTABLE_FILENAME\}"\n\$\{elseif\} \$2 == 1\nStrCpy \$3 "resources\\app\.asar"\n\$\{elseif\} \$2 == 2\nStrCpy \$3 "LICENSE\.electron\.txt"\n\$\{else\}\nStrCpy \$3 "resources\.pak"\n\$\{endif\}/);
    assert.match(precheck, /System::Call 'kernel32::CreateFileW\(w "\$1\\\$3", i 0x10000, i 7, p 0, i 3, i 0, p 0\) p\.r4 \?e'\nPop \$5/);
    assert.match(precheck, /IntOp \$2 \$2 \+ 1\n\$\{LoopWhile\} \$2 < 4\nGoto clawd_old_install_removable_done/);
  });

  it("issue #882: checks error 5 only for invalid handles and closes successful handles", () => {
    assert.match(precheck, /\$\{if\} \$4 == -1\n\$\{if\} \$5 == 5\nGoto clawd_old_install_removable_denied\n\$\{endif\}\n\$\{else\}\nSystem::Call 'kernel32::CloseHandle\(p r4\)'\n\$\{endif\}/);
    assert.strictEqual((precheck.match(/Goto clawd_old_install_removable_denied\b/g) || []).length, 1);
    assert.strictEqual((precheck.match(/\$\{if\} \$5\b/g) || []).length, 1);
  });

  it("issue #882: retries the probes and exits with code 2 on cancel, including silent mode", () => {
    assert.match(precheck, /MessageBox MB_RETRYCANCEL\|MB_ICONEXCLAMATION "\$0" \/SD IDCANCEL IDRETRY clawd_old_install_removable_retry\n(?:Pop \$\d\n)+SetErrorLevel 2\nQuit\n/);
    const retry = precheck.indexOf("clawd_old_install_removable_retry:");
    assert.ok(retry < precheck.indexOf("kernel32::CreateFileW"));
    assert.doesNotMatch(precheck.slice(retry), /^\s*Push\b/m, "retry must not accumulate saved registers");
  });

  it("issue #882: restores borrowed registers on completion and cancellation", () => {
    const saved = ["$0", "$1", "$2", "$3", "$4", "$5"];
    assert.ok(precheck.startsWith(saved.map((register) => `Push ${register}`).join("\n")));
    const restored = saved.toReversed().map((register) => `Pop ${register}`).join("\n");
    assert.ok(precheck.includes(`${restored}\nSetErrorLevel 2\nQuit`));
    assert.ok(precheck.endsWith(`clawd_old_install_removable_done:\n${restored}`));
    assert.doesNotMatch(precheck, /\$pid\b|\$R\d\b/);
  });

  it("issue #882: uses simplified Chinese, traditional Chinese and English with the probed directory", () => {
    const messages = precheck.match(/\$\{if\} \$LANGUAGE == 2052\nStrCpy \$0 "([^"\n]*)"\n\$\{elseif\} \$LANGUAGE == 1028\nStrCpy \$0 "([^"\n]*)"\n\$\{else\}\nStrCpy \$0 "([^"\n]*)"\n\$\{endif\}/);
    assert.ok(messages);
    assert.deepStrictEqual(messages.slice(1), [
      String.raw`无法更新 Clawd on Desk：当前 Windows 账户没有权限修改这个文件夹里的文件：$\r$\n$\r$\n$1$\r$\n$\r$\n可以给当前账户这个文件夹（含子文件夹）的“修改”权限，然后点“重试”；或者点“取消”，再以管理员身份运行安装程序。`,
      String.raw`無法更新 Clawd on Desk：目前的 Windows 帳戶沒有權限修改這個資料夾裡的檔案：$\r$\n$\r$\n$1$\r$\n$\r$\n可以給目前的帳戶這個資料夾（含子資料夾）的「修改」權限，然後按「重試」；或按「取消」，再以系統管理員身分執行安裝程式。`,
      String.raw`Clawd on Desk can't be updated because your Windows account doesn't have permission to change the files in this folder:$\r$\n$\r$\n$1$\r$\n$\r$\nGive your account Modify permission on this folder and its subfolders, then click Retry. Or click Cancel and run the installer as administrator.`,
    ]);
    assert.doesNotMatch(precheck, /\bLangString\b/);
    assert.notStrictEqual(installer.charCodeAt(0), 0xFEFF, "NSIS include must remain UTF-8 without BOM");
  });

  for (const name of ["customUnInstallCheck", "customUnInstallCheckCurrentUser"]) {
    it(`issue #882: keeps ${name} identical to the template except for /SD IDOK`, () => {
      const handler = template.match(/^Function handleUninstallResult\n([\s\S]*?)^FunctionEnd\b/m);
      assert.ok(handler, SYNC_MESSAGE);
      const defaultBranch = handler[1].match(/^  IfErrors 0 \+3\n[\s\S]*$/m);
      assert.ok(defaultBranch, SYNC_MESSAGE);
      const body = getMacroBody(installer, name);
      assert.strictEqual((body.match(/ \/SD IDOK/g) || []).length, 1);
      assert.strictEqual(body.replace(" /SD IDOK", ""), defaultBranch[0].trim(), SYNC_MESSAGE);
    });
  }
});
