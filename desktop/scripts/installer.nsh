; Inserted into electron-builder's NSIS template. Mostly cosmetic.

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInstall
  ; Make sure the per-user data folder exists so first run is silent.
  CreateDirectory "$APPDATA\MediaStudio"
!macroend

!macro customUnInstall
  ; Leave user data alone by default (deleteAppDataOnUninstall=false in package.json).
  ; If you want to nuke it, uncomment the next line.
  ; RMDir /r "$APPDATA\MediaStudio"
!macroend
