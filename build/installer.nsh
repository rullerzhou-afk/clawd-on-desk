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

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro CLAWD_CHECK_APP_RUNNING
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
