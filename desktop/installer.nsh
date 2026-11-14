; Keep app shortcuts in Martin's organized Apps folder. The learning shortcut
; selects the static, device-free launch path; ordinary launch stays Manual.
; Electron Builder's default running-app handler eventually terminates the app.
; This app owns a graceful Controller cleanup path, so updates wait for a
; normal exit instead. Silent installs return 2 and never open a prompt.
!macro customCheckAppRunning
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "if (Get-Process -Name 'Odradek Studio' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
  Pop $R0
  ${If} $R0 != 1
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Close Odradek Studio normally, then run this installer again. Your saved sessions will be kept."
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customInstall
  CreateDirectory "$DESKTOP\Apps"
  CreateShortCut "$DESKTOP\Apps\Odradek Studio.lnk" "$INSTDIR\Odradek Studio.exe"
  CreateShortCut "$DESKTOP\Apps\Odradek Studio Learning Lab.lnk" "$INSTDIR\Odradek Studio.exe" "--learning"
  CreateShortCut "$SMPROGRAMS\Odradek Studio Learning Lab.lnk" "$INSTDIR\Odradek Studio.exe" "--learning"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Apps\Odradek Studio.lnk"
  Delete "$DESKTOP\Apps\Odradek Studio Learning Lab.lnk"
  Delete "$SMPROGRAMS\Odradek Studio Learning Lab.lnk"
!macroend
