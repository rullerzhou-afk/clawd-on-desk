!macro customInstall
  SetOutPath "$INSTDIR"
  File "/oname=$INSTDIR\uninstall-claude-hooks.ps1" "${BUILD_RESOURCES_DIR}\uninstall-claude-hooks.ps1"
  FileOpen $0 "$INSTDIR\.clawd-install-user-home" w
  FileWrite $0 "$PROFILE"
  FileClose $0
!macroend

!macro customUnInstall
  IfFileExists "$INSTDIR\uninstall-claude-hooks.ps1" 0 clawd_uninstall_hooks_done
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\uninstall-claude-hooks.ps1" -InstallDir "$INSTDIR"'
    Pop $0
  clawd_uninstall_hooks_done:
!macroend
