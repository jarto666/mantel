; Offers Mantel as the home app of Windows' full screen experience (see home-app.ps1).
!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\home-app.ps1" -Version ${VERSION}'
  Pop $0
!macroend

; Updates install over the old copy and keep the registration, so the chosen home app stays.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\home-app.ps1" -Remove'
    Pop $0
  ${EndIf}
!macroend
