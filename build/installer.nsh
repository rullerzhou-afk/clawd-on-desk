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
