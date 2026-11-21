; customCheckAppRunning makes allowOnlyOneInstallerInstance.nsh skip these dependencies, so provide them here.
!include "getProcessInfo.nsh"
Var pid

; PowerShell 5.1 leaves .Count empty for one CimInstance, missing the last Clawd process (#882, electron-builder#10454).
; These macros match electron-builder 26.15.7 line for line except for @(...) and the CLAWD_FIND_PROCESS name.
; Resync with the template when upgrading electron-builder; remove this override once upstream fixes the count.
!macro CLAWD_FIND_PROCESS _FILE _RETURN
  ${if} $IsPowerShellAvailable == 0
    nsExec::Exec `"$PowerShellPath" -C "if (@(Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"`
    Pop ${_RETURN}
  ${else}
    !ifdef INSTALL_MODE_PER_ALL_USERS
      # exact match via findstr anchored to the start of each CSV line
      nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${_FILE}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${_FILE}\""`
      Pop ${_RETURN}
    !else
      # find process owned by current user — anchored exact match
      nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${_FILE}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${_FILE}\""`
      Pop ${_RETURN}
    !endif
  ${endIf}
!macroend

!macro CLAWD_CHECK_APP_RUNNING
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    ${if} ${isUpdated}
      # allow app to exit without explicit kill
      Sleep 300
    ${endIf}

    !insertmacro CLAWD_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      ${if} ${isUpdated}
        # allow app to exit without explicit kill
        Sleep 1000
        Goto doStopProcess
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
      Quit

      doStopProcess:

      DetailPrint "$(appClosing)"

      !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
      # to ensure that files are not "in-use"
      Sleep 300

      # Retry counter
      StrCpy $R1 0

      loop:
        IntOp $R1 $R1 + 1

        !insertmacro CLAWD_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
          # wait to give a chance to exit gracefully
          Sleep 1000
          !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1 # 1 = force kill
          !insertmacro CLAWD_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
          ${if} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
            Sleep 2000
          ${else}
            Goto not_running
          ${endIf}
        ${else}
          Goto not_running
        ${endIf}

        # App likely running with elevated permissions.
        # Ask user to close it manually
        ${if} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY loop
          Quit
        ${else}
          Goto loop
        ${endIf}
      not_running:
    ${endIf}
  ${endIf}
!macroend

!ifndef BUILD_UNINSTALLER
; Old files whose ACL denies the current account deletion make upgrades misreport that the app cannot be closed (#882).
; Sample the next SHELL_CONTEXT uninstallOldVersion target, excluding all-users mode's extra HKCU uninstall.
!macro CLAWD_CHECK_OLD_INSTALL_REMOVABLE
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5

  ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} $0 == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
    ${if} $0 == ""
      Goto clawd_old_install_removable_done
    ${endif}
  ${endif}

  ReadRegStr $1 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $1 == ""
    !insertmacro GetInQuotes $0 "$0"
    ${if} $0 != ""
      Push $0
      Call GetFileParent
      Pop $1
    ${endif}
  ${endif}
  ${if} $1 == ""
    Goto clawd_old_install_removable_done
  ${endif}
  IfFileExists "$1\*.*" 0 clawd_old_install_removable_done

  clawd_old_install_removable_retry:
    StrCpy $2 0
    ${Do}
      ; Sample common 1.x install files to catch typical deletion ACL failures.
      ${if} $2 == 0
        StrCpy $3 "${APP_EXECUTABLE_FILENAME}"
      ${elseif} $2 == 1
        StrCpy $3 "resources\app.asar"
      ${elseif} $2 == 2
        StrCpy $3 "LICENSE.electron.txt"
      ${else}
        StrCpy $3 "resources.pak"
      ${endif}

      ; DELETE=0x10000, share read/write/delete=7, OPEN_EXISTING=3. Interpret errors only for INVALID_HANDLE_VALUE (-1).
      ; Block only ERROR_ACCESS_DENIED (5), skip missing files (2/3), and leave sharing violations (32) and other errors to the normal flow.
      System::Call 'kernel32::CreateFileW(w "$1\$3", i 0x10000, i 7, p 0, i 3, i 0, p 0) p.r4 ?e'
      Pop $5
      ${if} $4 == -1
        ${if} $5 == 5
          Goto clawd_old_install_removable_denied
        ${endif}
      ${else}
        System::Call 'kernel32::CloseHandle(p r4)'
      ${endif}

      IntOp $2 $2 + 1
    ${LoopWhile} $2 < 4
    Goto clawd_old_install_removable_done

  clawd_old_install_removable_denied:
    ${if} $LANGUAGE == 2052
      StrCpy $0 "无法更新 Clawd on Desk：当前 Windows 账户没有权限修改这个文件夹里的文件：$\r$\n$\r$\n$1$\r$\n$\r$\n可以给当前账户这个文件夹（含子文件夹）的“修改”权限，然后点“重试”；或者点“取消”，再以管理员身份运行安装程序。"
    ${elseif} $LANGUAGE == 1028
      StrCpy $0 "無法更新 Clawd on Desk：目前的 Windows 帳戶沒有權限修改這個資料夾裡的檔案：$\r$\n$\r$\n$1$\r$\n$\r$\n可以給目前的帳戶這個資料夾（含子資料夾）的「修改」權限，然後按「重試」；或按「取消」，再以系統管理員身分執行安裝程式。"
    ${else}
      StrCpy $0 "Clawd on Desk can't be updated because your Windows account doesn't have permission to change the files in this folder:$\r$\n$\r$\n$1$\r$\n$\r$\nGive your account Modify permission on this folder and its subfolders, then click Retry. Or click Cancel and run the installer as administrator."
    ${endif}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$0" /SD IDCANCEL IDRETRY clawd_old_install_removable_retry
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
    SetErrorLevel 2
    Quit

  clawd_old_install_removable_done:
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
!macroend

; The template's uninstallFailed box waits indefinitely during silent upgrades without /SD (#882).
; Keep both result checks identical to installUtil.nsh except for the silent default button.
!macro customUnInstallCheck
  IfErrors 0 +3
  DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  Return

  ${if} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${endif}
!macroend

!macro customUnInstallCheckCurrentUser
  IfErrors 0 +3
  DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  Return

  ${if} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${endif}
!macroend
!endif

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro CLAWD_CHECK_APP_RUNNING
  ; The installer also checks deletion access before uninstalling the old version. The uninstaller skips this precheck.
  !ifndef BUILD_UNINSTALLER
    !insertmacro CLAWD_CHECK_OLD_INSTALL_REMOVABLE
  !endif
!macroend

!macro customInstall
  SetOutPath "$INSTDIR"
  File "/oname=$INSTDIR\uninstall-claude-hooks.ps1" "${BUILD_RESOURCES_DIR}\uninstall-claude-hooks.ps1"
  FileOpen $0 "$INSTDIR\.clawd-install-user-home" w
  FileWrite $0 "$PROFILE"
  FileClose $0
!macroend

!macro customUnInstall
  ; Upgrades run the old uninstaller: only real uninstalls clean hooks; startup sync handles path changes.
  ${ifNot} ${isUpdated}
    StrCpy $1 "$PROFILE"
    IfFileExists "$INSTDIR\.clawd-install-user-home" 0 clawd_node_cleanup_home_done
      FileOpen $0 "$INSTDIR\.clawd-install-user-home" r
      FileRead $0 $1
      FileClose $0
    clawd_node_cleanup_home_done:

    IfFileExists "$INSTDIR\Clawd on Desk.exe" 0 clawd_node_cleanup_done
    IfFileExists "$INSTDIR\resources\app.asar.unpacked\hooks\cleanup-integrations.js" 0 clawd_node_cleanup_done
      System::Call 'Kernel32::SetEnvironmentVariable(t, t)i("ELECTRON_RUN_AS_NODE", "1").r0'
      nsExec::ExecToLog '"$INSTDIR\Clawd on Desk.exe" "$INSTDIR\resources\app.asar.unpacked\hooks\cleanup-integrations.js" --apply --user-home "$1" --source nsis --fail-open'
      Pop $0
      System::Call 'Kernel32::SetEnvironmentVariable(t, t)i("ELECTRON_RUN_AS_NODE", "").r0'
    clawd_node_cleanup_done:

    IfFileExists "$INSTDIR\uninstall-claude-hooks.ps1" 0 clawd_uninstall_hooks_done
      nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\uninstall-claude-hooks.ps1" -InstallDir "$INSTDIR"'
      Pop $0
    clawd_uninstall_hooks_done:
  ${endIf}
!macroend
