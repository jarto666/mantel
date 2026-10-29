; Offers Mantel as the home app of Windows' full screen experience (see home-app.ps1).
; The installer is 32-bit; sysnative reaches the 64-bit PowerShell and with it the real registry.
!define HOME_APP_PS '"$WINDIR\sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\home-app.ps1"'

!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec '${HOME_APP_PS} -Version ${VERSION}'
  Pop $0
!macroend

; Updates install over the old copy and keep the registration, so the chosen home app stays.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    nsExec::Exec '${HOME_APP_PS} -Remove'
    Pop $0
  ${EndIf}
!macroend
