; 栖枝 · Alight installer skin. C「落蝶」的画面 + B 的实现做法 + A 的清点。第一期全静态：
; no timers, no GDI+, no alpha overlays, 24-bit BMPs, MUI directory page kept. Contract: design/installer/IMPL.md.
;
; electron-builder includes this file before MUI2.nsh, so the defines below configure the Modern UI.
; Window: 720 x 480 DIP client area (720 x 432 canvas + 48 button bar). Every size in this file is in DIP;
; AL_PX turns it into pixels with $alS (scale x 1000) so the layout is the same at any display scale.
; Page hooks (electron-builder):
;   welcome, finish        customWelcomePage / customFinishPage, customUnWelcomePage / customUninstallPage
;   license, directory     skipPageIfUpdated, redefined in installer-pages.nsh (also MUI_UNPAGE_INSTFILES)
;   install mode           customInstallMode (forced to the current user)
;   run check, files       customPageAfterChangeDir
;   uninstall: data choice, delete confirmation, run check  customUnWelcomePage (the only hook before the files page)
;   data deletion          customUnInstall (inside the uninstall section, app already closed)
; Art: build/installer/*.bmp (scripts/gen-installer-art.py), 2x masters scaled to the control at runtime.

ManifestDPIAware true

!define /ifndef AL_ART "${BUILD_RESOURCES_DIR}\installer"

; The real build must be the one whose Electron userData folder is alight-desk. The test build
; (installer-test.nsh defines AL_TEST_BUILD) uses a compile-time sandbox path instead.
!ifndef AL_TEST_BUILD
  !ifndef APP_PACKAGE_NAME
    !error "APP_PACKAGE_NAME is not defined: cannot tell which data folder this installer owns"
  !endif
  !if "${APP_PACKAGE_NAME}" != "alight-desk"
    !error "The installer data root is alight-desk, but package.json name is ${APP_PACKAGE_NAME}"
  !endif
!else
  ; The uninstaller also removes %LOCALAPPDATA%\<package name>-updater. The test build must never point at the real
  ; app's updater cache (alight-desk-updater): its package name is the test one.
  !ifndef APP_PACKAGE_NAME
    !error "APP_PACKAGE_NAME is not defined: cannot tell which updater cache this uninstaller owns"
  !endif
  !if "${APP_PACKAGE_NAME}" != "alightinsttest"
    !error "The test build must have the package name alightinsttest (eb-test.json extraMetadata.name), not ${APP_PACKAGE_NAME}"
  !endif
!endif

; ---- tokens (night) ----
!define AL_BG "0A0913"      ; window, header, welcome / finish plates
!define AL_PAGE "0E0C19"    ; inner pages and the button bar
!define AL_FIELD "1B1730"   ; edit box, rows, hint blocks
!define AL_TEXT "F4F0F7"
!define AL_TEXT2 "D8CFE0"
!define AL_TEXT3 "C0B4CF"
!define AL_TITLE "EFE3F3"
!define AL_ACCENT "D6C1E0"
!define AL_BLUE "7CC8F7"
!define AL_GOLD "E6C88A"
!define AL_GOLD_INK "6E4200"
!define AL_PAPER "F1EDF0"   ; the one bright surface: licence, receipts, lists
!define AL_INK "241C3A"
!define AL_INK2 "41385C"
!define AL_HAIR2 "463E51"
!define AL_HER_BAR "71647D"
; the same colours as COLORREF (0x00BBGGRR) for window messages
!define AL_BG_REF 0x0013090A
!define AL_TEXT_REF 0x00F7F0F4
!define AL_FIELD_REF 0x0030171B
!define AL_BLUE_REF 0x00F7C87C
!define AL_PAPER_REF 0x00F0EDF1
!define AL_INK_REF 0x003A1C24

; window styles for the controls this skin creates: WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS + static type
!define AL_SS_FILL 0x54000000   ; plain filled rectangle
!define AL_SS_FILLG 0x54020000  ; the same, starting a dialog group (it ends the group of the control above it)
!define AL_SS_TXT 0x54000080    ; wrapping text, no & prefix
!define AL_SS_ONE 0x5400008C    ; one line / CRLF lines, never wrapped (SS_LEFTNOWORDWRAP | SS_NOPREFIX)
!define AL_SS_PATH 0x5400808C   ; one line, path ellipsis
!define AL_SS_BMP 0x5400000E    ; SS_BITMAP
!define AL_WS_BTN 0x54010000    ; push button + tab stop
!define AL_WS_CHK 0x54010003    ; auto check box + tab stop
!define AL_WS_RADIO1 0x54030009 ; auto radio button, first of the group + tab stop
!define AL_WS_RADIO2 0x54010009 ; auto radio button + tab stop
!define AL_SS_IND 0x54000281    ; one centred glyph, centred vertically (SS_CENTER | SS_NOPREFIX | SS_CENTERIMAGE)
!define AL_WS_GROUP 0x00020000  ; marks the first control of a dialog group

; credits (native statics, not baked into the pictures)
!define AL_C_FIG "立绘：官方 © miHoYo"
!define AL_C_FACE "表情：官方 © miHoYo"
!define AL_C_AI "画面：AI 辅助同人图 · 非官方同人"

!ifdef BUILD_UNINSTALLER
  !define AL_P "un."
!else
  !define AL_P ""
!endif

!define MUI_BGCOLOR "${AL_BG}"
!define MUI_TEXTCOLOR "${AL_TEXT}"
!define MUI_FORCECLASSICCONTROLS          ; un-themed check boxes, so their text can be coloured
!define MUI_INSTFILESPAGE_PROGRESSBAR "smooth"
!ifdef BUILD_UNINSTALLER ; that pass also emits an (unused) .onGUIInit, so hook only the side it builds
  !define MUI_CUSTOMFUNCTION_UNGUIINIT un.alGuiInit
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT alGuiInit
!endif
!ifdef MUI_HEADERIMAGE_RIGHT
  !undef MUI_HEADERIMAGE_RIGHT              ; the header art covers the whole header
!endif

; Page texts in the skin's wording (MUI's language file only fills in strings that are not defined yet)
!define MUI_TEXT_LICENSE_TITLE "使用条款"
!define MUI_TEXT_LICENSE_SUBTITLE "阅读下面的条款；同意后才能安装。"
!define MUI_INNERTEXT_LICENSE_TOP " "
!define MUI_INNERTEXT_LICENSE_BOTTOM "栖枝是个人非商用同人项目。游戏、角色和官方图像的版权归米哈游／HoYoverse。$\r$\n夜景画面是 AI 辅助同人图，不是官方图像。$\r$\n同意以上条款，点「我同意」继续安装；不同意则无法安装。"
!define MUI_TEXT_DIRECTORY_TITLE "安装位置"
!define MUI_TEXT_DIRECTORY_SUBTITLE "选择栖枝的安装位置。"
!define MUI_TEXT_INSTALLING_TITLE "正在安装"
!define MUI_TEXT_INSTALLING_SUBTITLE "栖枝正在安装，请稍候。"
!define MUI_TEXT_FINISH_TITLE "安装完成"
!define MUI_TEXT_FINISH_SUBTITLE "栖枝已安装。"
!define MUI_UNTEXT_UNINSTALLING_TITLE "正在卸载"
!define MUI_UNTEXT_UNINSTALLING_SUBTITLE "栖枝正在卸载，请稍候。"
!define MUI_UNTEXT_FINISH_TITLE "已卸载"
!define MUI_UNTEXT_FINISH_SUBTITLE "栖枝已卸载。"

; size phrase for the welcome page, from electron-builder's ESTIMATED_SIZE (KB); never a made-up number
!ifdef ESTIMATED_SIZE
  !define /math AL_EST_MB ${ESTIMATED_SIZE} / 1024
  !define AL_SIZE_PHRASE "占用约 ${AL_EST_MB} MB。"
!else
  !define AL_SIZE_PHRASE "占用空间见下一步里的「安装位置」。"
!endif

; ---- layout macros (all in DIP; $R6-$R9 are scratch) ----

; OUT = DIP * scale, rounded
!macro AL_PX OUT DIP
  IntOp ${OUT} ${DIP} * $alS
  IntOp ${OUT} ${OUT} + 500
  IntOp ${OUT} ${OUT} / 1000
!macroend

; move / resize a control (client coordinates of its parent)
!macro AL_POS CTL X Y W H
  !insertmacro AL_PX $R6 ${X}
  !insertmacro AL_PX $R7 ${Y}
  !insertmacro AL_PX $R8 ${W}
  !insertmacro AL_PX $R9 ${H}
  System::Call 'user32::SetWindowPos(p ${CTL}, p 0, i R6, i R7, i R8, i R9, i 0x14)' ; SWP_NOZORDER | SWP_NOACTIVATE
!macroend

; send a control to the bottom of the z-order
!macro AL_BOTTOM CTL
  System::Call 'user32::SetWindowPos(p ${CTL}, p 1, i 0, i 0, i 0, i 0, i 0x13)' ; HWND_BOTTOM, NOSIZE | NOMOVE | NOACTIVATE
!macroend

; add WS_CLIPSIBLINGS to a control that came from a dialog template (so a sibling's fill cannot paint over it)
!macro AL_CLIP CTL
  System::Call 'user32::GetWindowLongW(p ${CTL}, i -16) i.R6' ; GWL_STYLE
  IntOp $R6 $R6 | 0x04000000
  System::Call 'user32::SetWindowLongW(p ${CTL}, i -16, i R6)'
!macroend

; create a child window (STATIC / BUTTON) under PARENT. FONT / FG are skipped when empty; a coloured
; control is always opaque. TEXT may hold variables. A new child window lands at the BOTTOM of the
; z-order, under the full-page pictures, so it is raised right away: later controls end up above earlier ones.
!macro AL_CTL OUT PARENT CLASS X Y W H STYLE FONT FG BG TEXT
  !insertmacro AL_PX $R6 ${X}
  !insertmacro AL_PX $R7 ${Y}
  !insertmacro AL_PX $R8 ${W}
  !insertmacro AL_PX $R9 ${H}
  System::Call 'user32::CreateWindowExW(i 0, w "${CLASS}", p 0, i ${STYLE}, i R6, i R7, i R8, i R9, p ${PARENT}, p 0, p 0, p 0) p.s'
  Pop ${OUT}
  System::Call 'user32::SetWindowPos(p ${OUT}, p 0, i 0, i 0, i 0, i 0, i 0x13)' ; HWND_TOP, NOSIZE | NOMOVE | NOACTIVATE
  !if "${FONT}" != ""
    SendMessage ${OUT} ${WM_SETFONT} ${FONT} 0
  !endif
  !if "${FG}" != ""
    SetCtlColors ${OUT} "${FG}" "${BG}"
  !endif
  !if "${TEXT}" != ""
    SendMessage ${OUT} ${WM_SETTEXT} 0 "STR:${TEXT}"
  !endif
!macroend

; a button / check box / radio button made by nsDialogs itself (on a page made with nsDialogs::Create):
; ${NSD_OnClick} callbacks only fire for controls nsDialogs created, not for ones made with CreateWindowEx.
; Same arguments as AL_CTL; STYLE is the full window style.
!macro AL_NSD OUT X Y W H STYLE FONT FG BG TEXT
  !insertmacro AL_PX $R6 ${X}
  !insertmacro AL_PX $R7 ${Y}
  !insertmacro AL_PX $R8 ${W}
  !insertmacro AL_PX $R9 ${H}
  nsDialogs::CreateControl BUTTON ${STYLE} 0 $R6 $R7 $R8 $R9 "${TEXT}"
  Pop ${OUT}
  System::Call 'user32::SetWindowPos(p ${OUT}, p 0, i 0, i 0, i 0, i 0, i 0x13)' ; HWND_TOP
  !if "${FONT}" != ""
    SendMessage ${OUT} ${WM_SETFONT} ${FONT} 0
  !endif
  !if "${FG}" != ""
    SetCtlColors ${OUT} "${FG}" "${BG}"
  !endif
!macroend

; a static text / filled rectangle
!macro AL_LBL OUT PARENT X Y W H STYLE FONT FG BG TEXT
  !insertmacro AL_CTL ${OUT} ${PARENT} STATIC ${X} ${Y} ${W} ${H} ${STYLE} "${FONT}" "${FG}" "${BG}" "${TEXT}"
!macroend

; embed a BMP from build/installer and fit it exactly into the control
!macro AL_IMG CTL NAME
  InitPluginsDir
  File "/oname=$PLUGINSDIR\${NAME}" "${AL_ART}\${NAME}"
  StrCpy $alA ${CTL}
  StrCpy $alB "$PLUGINSDIR\${NAME}"
  Call ${AL_P}alSetImg
!macroend

; a picture control; ZBOT 1 sends it to the bottom (full-page pictures), 0 leaves it on top (icons)
!macro AL_BMP OUT PARENT NAME X Y W H ZBOT
  !insertmacro AL_CTL ${OUT} ${PARENT} STATIC ${X} ${Y} ${W} ${H} ${AL_SS_BMP} "" "" "" ""
  !insertmacro AL_IMG ${OUT} ${NAME}
  !if ${ZBOT} == 1
    !insertmacro AL_BOTTOM ${OUT}
  !endif
!macroend

; "her words": a 2 DIP bar and the line, left indented by 10
!macro AL_HER PARENT X Y W H BG TEXT
  !insertmacro AL_LBL $0 ${PARENT} ${X} ${Y} 2 ${H} ${AL_SS_FILL} "" "${AL_HER_BAR}" "${AL_HER_BAR}" ""
  IntOp $R4 ${X} + 10
  IntOp $R5 ${W} - 10
  StrCpy $alA "${TEXT}"
  StrCpy $alB $alF13
  StrCpy $alC $R5
  Call ${AL_P}alTextH
  !insertmacro AL_LBL $0 ${PARENT} $R4 ${Y} $R5 ${H} ${AL_SS_ONE} $alF13 "${AL_ACCENT}" "${BG}" "$alWT"
!macroend

; a credit line, W DIP wide (keep it clear of anything else on the page: the box is opaque)
!macro AL_CREDW PARENT X Y W BG TEXT
  !insertmacro AL_LBL $0 ${PARENT} ${X} ${Y} ${W} 14 ${AL_SS_ONE} $alF11 "${AL_TEXT3}" "${BG}" "${TEXT}"
!macroend
!macro AL_CRED PARENT X Y BG TEXT
  !insertmacro AL_CREDW ${PARENT} ${X} ${Y} 300 "${BG}" "${TEXT}"
!macroend

; The receipts are flowed, not placed: the rows run down from a running y in $3 and the page decides how much
; room they get. A page lays its rows out in a dry run first ($alDry = 1: measure only, nothing is created), and
; if they do not fit it asks again with a tighter tier in $alMode (see alSetMode): 0 normal, 1 smaller path
; font and gaps, 2 each path on one line with its middle left out and a "copy" button of its own beside it (the
; full text stays copyable), 3 as 2 and fewer listed items.

; one text row of a receipt on the paper: label (LX, 58 wide) and a value (VX, VW wide, the whole width), both
; laid out from the running y in $3, which moves on by the height of the value plus the gap. The value is broken
; into lines by alTextH (never inside a word or a number and its unit) and put into a no-wrap static; its height is
; measured with the value's own font, so the paper can be sized from the rows.
!macro AL_RTXT PARENT LX VX VW LBL VAL
  StrCpy $alA "${VAL}"
  StrCpy $alB $alF12
  StrCpy $alC ${VW}
  Call ${AL_P}alTextH
  StrCpy $alH $alR
  ${If} $alDry <> 1
    IntOp $R5 $3 + 1
    !insertmacro AL_LBL $0 ${PARENT} ${LX} $R5 58 16 ${AL_SS_ONE} $alF11 "${AL_INK2}" "${AL_PAPER}" "${LBL}"
    !insertmacro AL_LBL $0 ${PARENT} ${VX} $3 ${VW} $alH ${AL_SS_ONE} $alF12 "${AL_INK}" "${AL_PAPER}" "$alWT"
  ${EndIf}
  IntOp $3 $3 + $alH
  IntOp $3 $3 + $alGap
!macroend

; one path row of a receipt: the path in the small monospace font, broken at a backslash (or by width) onto
; as many lines as it needs, or (tier 2 and up) on one line, head and tail kept and the middle left out, with a
; "copy" button of its own beside it that copies that path in full. Same running y in $3.
!macro AL_RPATH PARENT LX VX VW LBL PATH
  !insertmacro AL_PATHCP ${PARENT} ${VX} $3 ${VW} "${AL_INK}" "${AL_PAPER}" "${AL_TEXT}" "${PATH}"
  ${If} $alDry <> 1
    IntOp $R5 $3 + 1
    !insertmacro AL_LBL $0 ${PARENT} ${LX} $R5 58 16 ${AL_SS_ONE} $alF11 "${AL_INK2}" "${AL_PAPER}" "${LBL}"
  ${EndIf}
  IntOp $3 $3 + $alH
  IntOp $3 $3 + $alGap
!macroend

; a note row that continues the path row above it: pulls the running y back up a little
!macro AL_TUCK
  IntOp $3 $3 - 2
!macroend

; the copy row of the "part of it could not be deleted" paper, always there (one path or many, shortened or not) as
; long as there is something to copy ($alCopy: the full paths, one per line, without any note). One button, the label
; says what it copies: $alCopyLbl ("复制路径" for one, "复制全部路径" for all of them).
!macro AL_COPYROW PARENT X
  ${If} $alCopy != ""
    ${If} $alDry <> 1
      !insertmacro AL_NSD $0 ${X} $3 132 22 ${AL_WS_BTN} $alF11 "" "" "$alCopyLbl"
      System::Call 'uxtheme::SetWindowTheme(p $0, w "DarkMode_Explorer", p 0)'
      SetCtlColors $0 "${AL_TEXT}" "${AL_PAPER}"
      ${NSD_OnClick} $0 ${AL_P}alCopyClick
    ${EndIf}
    IntOp $3 $3 + 22
    IntOp $3 $3 + $alGap
  ${EndIf}
!macroend

; a path on its own line(s) on a page colour: width W, running height left in $alH, text in the given colour
!macro AL_PATHBOX PARENT X Y W FG BG PATH
  StrCpy $alA "${PATH}"
  StrCpy $alC ${W}
  Call ${AL_P}alPathWrap
  IntOp $alH $alN * $alLH
  !insertmacro AL_LBL $0 ${PARENT} ${X} ${Y} ${W} $alH ${AL_SS_ONE} $alFm "${FG}" "${BG}" "$alR"
!macroend

; A path at (X, Y), W DIP wide, FG on BG, in the font of the current tier (alSetMode). Tier 0 / 1: broken onto as
; many lines as it needs. Tier 2 and up: one line with the middle left out, and a "copy" button at its right end
; (text BTNFG) that puts the full PATH on the clipboard. Leaves the height of the row in $alH; with $alDry = 1 it
; only measures. Uses $R2-$R5.
!macro AL_PATHCP PARENT X Y W FG BG BTNFG PATH
  StrCpy $alA "${PATH}"
  ${If} $alMode >= 2
    IntOp $alC ${W} - 52
  ${Else}
    StrCpy $alC ${W}
  ${EndIf}
  Call ${AL_P}alPathWrap
  IntOp $alH $alN * $alLH
  ${If} $alMode >= 2
  ${AndIf} $alH < 18
    IntOp $R4 18 - $alH
    IntOp $R4 $R4 / 2
    StrCpy $alH 18
  ${Else}
    StrCpy $R4 0
  ${EndIf}
  ${If} $alDry <> 1
    IntOp $R5 ${Y} + $R4
    IntOp $R3 $alN * $alLH
    ${If} $alMode = 0
      !insertmacro AL_LBL $0 ${PARENT} ${X} $R5 ${W} $R3 ${AL_SS_ONE} $alFm "${FG}" "${BG}" "$alR"
    ${ElseIf} $alMode = 1
      !insertmacro AL_LBL $0 ${PARENT} ${X} $R5 ${W} $R3 ${AL_SS_ONE} $alFm10 "${FG}" "${BG}" "$alR"
    ${Else}
      !insertmacro AL_LBL $0 ${PARENT} ${X} $R5 $alC $R3 ${AL_SS_ONE} $alFm10 "${FG}" "${BG}" "$alR"
      IntOp $R3 ${X} + ${W}
      IntOp $R3 $R3 - 48
      !insertmacro AL_NSD $R2 $R3 ${Y} 48 18 ${AL_WS_BTN} $alF11 "" "" "复制"
      System::Call 'uxtheme::SetWindowTheme(p $R2, w "DarkMode_Explorer", p 0)'
      SetCtlColors $R2 "${BTNFG}" "${BG}"
      ${NSD_OnClick} $R2 ${AL_P}alCopyClick
      StrCpy $alA $R2
      StrCpy $alB "${PATH}"
      Call ${AL_P}alCopyTag
    ${EndIf}
  ${EndIf}
!macroend

; Dress an existing check box (a BUTTON that keeps the state, the keyboard and the click) in the skin: the button
; draws its own label (TEXT, in the skin's colours, in the page font), and only its white box is covered by a
; ☐ / ☑ glyph static (it lets clicks through). The label is the button's own so that the system's focus rectangle
; shows around it when the box has the keyboard focus (a dotted line after Tab, which the glyph does not cover). FUNC is
; the click callback (it must call alChkSync on the button to redraw the glyph). Uses $R3.
!macro AL_CHKDRESS BTN PARENT X Y W H FG BG TEXT FUNC
  !insertmacro AL_POS ${BTN} ${X} ${Y} ${W} ${H}
  SendMessage ${BTN} ${WM_SETTEXT} 0 "STR:${TEXT}"
  System::Call 'uxtheme::SetWindowTheme(p ${BTN}, w " ", w " ")'
  SendMessage ${BTN} ${WM_SETFONT} $alF12 0
  SetCtlColors ${BTN} "${FG}" "${BG}"
  System::Call 'user32::SetWindowPos(p ${BTN}, p 0, i 0, i 0, i 0, i 0, i 0x13)' ; HWND_TOP
  !insertmacro AL_LBL $R3 ${PARENT} ${X} ${Y} 16 ${H} ${AL_SS_IND} $alFsym "${FG}" "${BG}" "☐"
  System::Call 'user32::SetPropW(p ${BTN}, w "alg", p R3)'
  ${NSD_OnClick} ${BTN} ${FUNC}
  StrCpy $alA ${BTN}
  Call ${AL_P}alChkSync
!macroend

; a new check box made by nsDialogs on the current page, dressed the same way
!macro AL_CHKNEW OUT PARENT X Y W H FG BG TEXT FUNC
  !insertmacro AL_NSD ${OUT} ${X} ${Y} ${W} ${H} ${AL_WS_CHK} $alF12 "" "" ""
  !insertmacro AL_CHKDRESS ${OUT} ${PARENT} ${X} ${Y} ${W} ${H} "${FG}" "${BG}" "${TEXT}" ${FUNC}
!macroend

; font: size in half DIP, weight, face -> HFONT in OUT
!macro AL_FONT OUT HALF WEIGHT FACE
  IntOp $R6 ${HALF} * $alS
  IntOp $R6 $R6 + 1000
  IntOp $R6 $R6 / 2000
  IntOp $R6 0 - $R6
  System::Call 'gdi32::CreateFontW(i R6, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "${FACE}") p.s'
  Pop ${OUT}
!macroend

; the button bar: texts, widths and positions. An empty text hides that button. Primary button
; width NEXTW. With the Cancel button hidden the primary button takes its place on the right.
!macro AL_BAR BACK NEXT NEXTW CANCEL
  ShowWindow $mui.Button.Next ${SW_SHOW} ; the files pages hide it while they work
  EnableWindow $mui.Button.Next 1        ; (the confirmation page switches it off again after this)
  StrCpy $R5 704
  !if "${CANCEL}" != ""
    ShowWindow $mui.Button.Cancel ${SW_SHOW}
    SendMessage $mui.Button.Cancel ${WM_SETTEXT} 0 "STR:${CANCEL}"
    !insertmacro AL_POS $mui.Button.Cancel 620 441 84 30
    StrCpy $R5 612
  !else
    ShowWindow $mui.Button.Cancel ${SW_HIDE}
  !endif
  IntOp $R4 $R5 - ${NEXTW}
  SendMessage $mui.Button.Next ${WM_SETTEXT} 0 "STR:${NEXT}"
  !insertmacro AL_POS $mui.Button.Next $R4 441 ${NEXTW} 30
  IntOp $R5 $R4 - 8
  !if "${BACK}" != ""
    IntOp $R4 $R5 - 84
    ShowWindow $mui.Button.Back ${SW_SHOW}
    SendMessage $mui.Button.Back ${WM_SETTEXT} 0 "STR:${BACK}"
    !insertmacro AL_POS $mui.Button.Back $R4 441 84 30
  !else
    ShowWindow $mui.Button.Back ${SW_HIDE}
  !endif
!macroend

; the data root: where Electron keeps userData for this app. Always the current user's roaming folder.
!macro AL_INITDATA
  !ifdef AL_TEST_BUILD
    StrCpy $alDataRoot "${AL_DATA_ROOT}"
  !else
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    StrCpy $alDataRoot "$APPDATA\alight-desk"
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  !endif
!macroend

; ---- electron-builder hooks ----

!macro customWelcomePage
  !include "installer-pages.nsh"

  ; The elevated copy that UAC starts for an all-users install begins again at page one: it has
  ; already been welcomed. (Same for an in-app update, like electron-builder's license page.)
  Function alWelcomePre
    ${If} ${UAC_IsInnerInstance}
    ${OrIf} ${isUpdated}
      Abort
    ${EndIf}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_PRE alWelcomePre
  !define MUI_WELCOMEPAGE_TITLE "安装栖枝"
  !define MUI_WELCOMEPAGE_TEXT "栖枝 · Alight 是遐蝶主题的 Agent 工作台。默认安装给当前用户，不需要管理员权限，${AL_SIZE_PHRASE}"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW alWelcomeShow
  !insertmacro MUI_PAGE_WELCOME
  ; read by the directory page further on (no page in between uses it)
  !define MUI_DIRECTORYPAGE_TEXT_TOP "栖枝将安装到下面的文件夹。要换位置，点「浏览」；点「安装」开始。"
!macroend

!macro customInstallMode
  ; expanded inside the install-mode page's own function, before it calls its SHOW callback. The page
  ; is never shown: the app runs as the current user. (The uninstall pass keeps electron-builder's logic.)
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceCurrentInstall 1
  !endif
  !ifndef MUI_PAGE_CUSTOMFUNCTION_SHOW
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW ${AL_P}alDarkPage
  !endif
!macroend

; after the directory page, before the files page: the "is it running" page, then the files page
!macro customPageAfterChangeDir
  Page custom alRunPre alRunLeave
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW alInstShow
!macroend

; electron-builder's default finish page, plus our texts and SHOW callback
!macro customFinishPage
  !ifdef AL_TEST_BUILD
    ; The test build shows the "run" box (so its place on the page can be checked) but ticking it starts
    ; nothing: the installed test app would use the real user data folder.
    Function alTestNoRun
    FunctionEnd

    !define AL_SHOW_RUN
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "alTestNoRun"
    !define MUI_FINISHPAGE_RUN_TEXT "运行栖枝"
  !else
    !ifndef HIDE_RUN_AFTER_FINISH
      Function StartApp
        ${if} ${isUpdated}
          StrCpy $1 "--updated"
        ${else}
          StrCpy $1 ""
        ${endif}
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
      FunctionEnd

      !define AL_SHOW_RUN
      !define MUI_FINISHPAGE_RUN
      !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
      !define MUI_FINISHPAGE_RUN_TEXT "运行栖枝"
    !endif
  !endif
  !define MUI_FINISHPAGE_TITLE "安装完成"
  !define MUI_FINISHPAGE_TEXT " "
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW alFinishShow
  !insertmacro MUI_PAGE_FINISH
!macroend

; The uninstaller is a fixed run of pages: welcome, data choice, delete confirmation (only for "drop"),
; run check (only while the app runs), files, finish. This hook is the only place that can put pages in
; front of the files page. Silent and --updated runs show none of them: $alDrop stays empty = keep.
!macro customUnWelcomePage
  !include "installer-pages.nsh"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.alWelcomeShow
  !define MUI_WELCOMEPAGE_TITLE "卸载栖枝"
  !define MUI_WELCOMEPAGE_TEXT "将从下面的位置移除程序文件，以及桌面和开始菜单的快捷方式："
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.alChoosePre un.alChooseLeave
  UninstPage custom un.alConfirmPre un.alConfirmLeave
  UninstPage custom un.alRunPre un.alRunLeave
!macroend

; The finish page itself is inserted by electron-builder right after this hook (MUI_UNPAGE_FINISH):
; only defines here, never a second page.
!macro customUninstallPage
  !define MUI_FINISHPAGE_TITLE "已卸载"
  !define MUI_FINISHPAGE_TEXT " "
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "打开数据文件夹"
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION un.alOpenData
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.alFinishShow
!macroend

!macro customHeader
  ; display name only: registry keys and paths use electron-builder's PRODUCT_NAME / APP_* defines.
  ; common.nsh set both already; overriding them is intended (warning 6029 "specified multiple times")
  !pragma warning push
  !pragma warning disable 6029
  Name "栖枝 · Alight"
  BrandingText "蝶落枝头 · Alight ${VERSION}"
  !pragma warning pop
  !ifdef BUILD_UNINSTALLER
    Caption "栖枝 · Alight ${VERSION} 卸载"
    UninstallCaption "栖枝 · Alight ${VERSION} 卸载"
  !else
    Caption "栖枝 · Alight ${VERSION} 安装"
  !endif
  SetFont /LANG=${LANG_SIMPCHINESE} "Microsoft YaHei UI" 9
  ; NSIS's own strings use a half-width colon and a space; the rest of the skin uses the full-width colon
  LangString ^SpaceRequired ${LANG_SIMPCHINESE} "所需空间："
  LangString ^SpaceAvailable ${LANG_SIMPCHINESE} "可用空间："
  LangString ^Delete ${LANG_SIMPCHINESE} "删除文件："
  ; the MUI variables used below exist once the pages are inserted, which is before customHeader
  !insertmacro AL_COMMON
  !ifdef BUILD_UNINSTALLER
    !insertmacro AL_UNINSTALLER
  !else
    !insertmacro AL_INSTALLER
  !endif
!macroend

!macro customInit
  !insertmacro AL_INITDATA
  ; the version that is installed now, for the "old -> new" line of an update
  ReadRegStr $alPrevVer SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  !ifdef AL_TEST_BUILD
    ; a silent --force-run would start the installed app, whose userData is the real alight-desk
    ${If} ${isForceRun}
      Abort
    ${EndIf}
  !endif
!macroend

!macro customUnInit
  !insertmacro AL_INITDATA
  ; electron-builder's own --delete-app-data would, later in the uninstall section and without asking, run
  ; RMDir /r on the userData folders (it follows junctions inside them). This uninstaller never does that:
  ; the option stops the uninstall here, before anything is touched, silent or not. Data is only ever
  ; removed through the "drop" choice on the data page, which deletes entry by entry.
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    MessageBox MB_OK|MB_ICONINFORMATION "卸载程序不接受 --delete-app-data。$\r$\n这个选项会不经确认，直接删除整个数据文件夹。$\r$\n$\r$\n要删除数据，请运行卸载程序，在「数据的去向」里选「放下」。$\r$\n没有改动任何东西。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  ClearErrors
!macroend

!macro customInstall
  ${IfNot} ${Silent}
    SetDetailsPrint both
    DetailPrint "程序文件、快捷方式和卸载登记已写好"
    SetDetailsPrint none
  ${EndIf}
!macroend

; runs in the uninstall section after the app is closed and before the program files are removed
!macro customUnInstall
  ${If} $alDrop == 1
  ${AndIfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    Call un.alDropData
  ${EndIf}
  ; the auto-updater's download cache is not user data: it goes whether the data stays or not (never on an update run)
  Call un.alDropCache
  ${IfNot} ${Silent}
    SetDetailsPrint both
    DetailPrint "正在移除程序文件。"
    ; the rest of the section would put NSIS's raw "Delete file: ..." lines into the status line
    SetDetailsPrint none
    !insertmacro AL_INV 2 b "进行中"
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------------------------------
; Functions. Each makensis pass (installer, uninstaller) must define only the functions it calls, because
; electron-builder builds with warnings as errors and an unused function is a warning.
; ---------------------------------------------------------------------------------------------------

; Word-list macros for alBrk (top level: a macro cannot be defined inside AL_COMMON). The break asked about is at
; $alBP in $alBT; jumps to alb_no when it would fall inside the word. $5 is the offset, $3 the piece compared.
!macro AL_PROT2 W
  ${If} $alBP >= 1
    IntOp $5 $alBP - 1
    StrCpy $3 $alBT 2 $5
    ${If} $3 == "${W}"
      Goto alb_no
    ${EndIf}
  ${EndIf}
!macroend
!macro AL_PROT3 W
  ${If} $alBP >= 1
    IntOp $5 $alBP - 1
    StrCpy $3 $alBT 3 $5
    ${If} $3 == "${W}"
      Goto alb_no
    ${EndIf}
  ${EndIf}
  ${If} $alBP >= 2
    IntOp $5 $alBP - 2
    StrCpy $3 $alBT 3 $5
    ${If} $3 == "${W}"
      Goto alb_no
    ${EndIf}
  ${EndIf}
!macroend
!macro AL_PROT4 W
  ${If} $alBP >= 1
    IntOp $5 $alBP - 1
    StrCpy $3 $alBT 4 $5
    ${If} $3 == "${W}"
      Goto alb_no
    ${EndIf}
  ${EndIf}
  ${If} $alBP >= 2
    IntOp $5 $alBP - 2
    StrCpy $3 $alBT 4 $5
    ${If} $3 == "${W}"
      Goto alb_no
    ${EndIf}
  ${EndIf}
  ${If} $alBP >= 3
    IntOp $5 $alBP - 3
    StrCpy $3 $alBT 4 $5
    ${If} $3 == "${W}"
      Goto alb_no
    ${EndIf}
  ${EndIf}
!macroend

; functions and variables both passes use
!macro AL_COMMON
  Var alS     ; DIP -> pixel scale x 1000
  Var alA     ; call arguments and results (instead of the stack)
  Var alB
  Var alR
  Var alDlg   ; the page dialog of a custom page
  Var alF11
  Var alF12
  Var alF13
  Var alF13b
  Var alF15b
  Var alF20b
  Var alFm
  Var alFsym  ; a symbol font for the radio indicators
  Var alDataRoot
  Var alAccKB ; size sums: whole KB, plus the bytes that do not fill a KB yet (0..1023)
  Var alAccR
  Var alAccN
  Var alAccE
  Var alDry   ; 1 = a page lays its rows out only to measure them
  Var alMode  ; layout tier of the receipts, see alSetMode
  Var alLH    ; line height (DIP) of a monospace path line in this tier
  Var alGap   ; gap (DIP) between receipt rows in this tier
  Var alFm10  ; the smaller monospace font of tiers 1 and up
  Var alTier  ; the tier being tried
  Var alC     ; width argument of alTextH / alPathWrap (DIP)
  Var alN     ; line count result of alPathWrap
  Var alH     ; a height in DIP, between macros
  Var alPaper ; the paper fill of the receipt / table on this page
  Var alWT    ; alTextH: the text broken into lines (CRLF) that the page puts into a no-wrap static
  Var alWL    ; length of its last line
  Var alWpx   ; the line width (px) alWrapRun breaks to
  Var alWdc   ; a DC with the font selected, and a scratch buffer (size at +0, one character at +16)
  Var alWsz
  Var alBT    ; alBrk: the text and the position it is asked about; the verdict (0 no, 1 possible, 2 good)
  Var alBP
  Var alBR
  !ifdef BUILD_UNINSTALLER
    ; declared here, not in AL_UNINSTALLER: alCopyClick below is compiled from this macro first, and a $alCopy
    ; it cannot see yet is read as $alC + "opy" (which put "270opy" on the clipboard)
    Var alCopy    ; the full paths that the "copy all paths" button puts on the clipboard
  !endif

  ; Fit a BMP exactly into a static bitmap control, HALFTONE filtered, 24-bit master 2x.
  ; $alA = control, $alB = BMP path; $alR = the new HBITMAP, or 0
  Function ${AL_P}alSetImg
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    StrCpy $9 0
    System::Call '*(i,i,i,i) p.r2'
    System::Call 'user32::GetClientRect(p $alA, p r2)'
    System::Call '*$2(i,i,i.r3,i.r4)'
    System::Free $2
    System::Call 'user32::LoadImageW(p 0, w "$alB", i 0, i 0, i 0, i 0x2010) p.r5' ; IMAGE_BITMAP, LR_LOADFROMFILE | LR_CREATEDIBSECTION
    ${If} $3 > 0
    ${AndIf} $4 > 0
    ${AndIf} $5 != 0
      System::Call '*(i,i,i,i,&i2,&i2,p) p.r2'
      System::Call 'gdi32::GetObjectW(p r5, i 24, p r2)'
      System::Call '*$2(i,i.r6,i.r7)'
      System::Free $2
      System::Call 'user32::GetDC(p 0) p.R0'
      System::Call 'gdi32::CreateCompatibleDC(p R0) p.R1'
      System::Call 'gdi32::CreateCompatibleDC(p R0) p.R2'
      System::Call 'gdi32::CreateCompatibleBitmap(p R0, i r3, i r4) p.r9'
      System::Call 'gdi32::SelectObject(p R1, p r5) p.r8'
      System::Call 'gdi32::SelectObject(p R2, p r9) p.R3'
      System::Call 'gdi32::SetStretchBltMode(p R2, i 4)' ; HALFTONE
      System::Call 'gdi32::SetBrushOrgEx(p R2, i 0, i 0, p 0)'
      System::Call 'gdi32::StretchBlt(p R2, i 0, i 0, i r3, i r4, p R1, i 0, i 0, i r6, i r7, i 0x00CC0020)' ; SRCCOPY
      System::Call 'gdi32::SelectObject(p R1, p r8)'
      System::Call 'gdi32::SelectObject(p R2, p R3)'
      System::Call 'gdi32::DeleteDC(p R1)'
      System::Call 'gdi32::DeleteDC(p R2)'
      System::Call 'user32::ReleaseDC(p 0, p R0)'
      SendMessage $alA ${STM_SETIMAGE} ${IMAGE_BITMAP} $9
    ${EndIf}
    ${If} $5 != 0
      System::Call 'gdi32::DeleteObject(p r5)'
    ${EndIf}
    StrCpy $alR $9
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    Pop $9
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = id of an etched line of the main window: put a flat line of our colour in its place, just
  ; below it in the z-order (so full-window pages still cover it), and move the original off-screen.
  Function ${AL_P}alFlatLine
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    GetDlgItem $0 $HWNDPARENT $alA
    System::Call '*(i,i,i,i) p.r1'
    System::Call 'user32::GetWindowRect(p r0, p r1)'
    System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r1, i 2)'
    System::Call '*$1(i.r2,i.r3,i.r4,i.r5)'
    System::Free $1
    IntOp $4 $4 - $2
    IntOp $5 $5 - $3
    System::Call 'user32::CreateWindowExW(i 0, w "STATIC", p 0, i 0x50000000, i r2, i r3, i r4, i r5, p $HWNDPARENT, p 0, p 0, p 0) p.r1' ; WS_CHILD | WS_VISIBLE
    SetCtlColors $1 "${AL_HAIR2}" "${AL_HAIR2}"
    System::Call 'user32::SetWindowPos(p r1, p r0, i 0, i 0, i 0, i 0, i 0x13)' ; after the original: SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
    System::Call 'user32::SetWindowPos(p r0, p 0, i 0, i -100, i 0, i 0, i 0x15)' ; off-screen: SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; Outer window: scale, size, fonts, caption, header, hairlines, buttons. Runs once, after MUI's own init.
  Function ${AL_P}alGuiInit
    ; dark caption on Windows 10 2004+ / 11; the colour attributes are Windows 11 only
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i ${AL_BG_REF}, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, *i ${AL_TEXT_REF}, i 4)'

    ; scale: system DPI / 96, x 1000
    System::Call 'user32::GetDC(p 0) p.r1'
    System::Call 'gdi32::GetDeviceCaps(p r1, i 88) i.r2' ; LOGPIXELSX
    System::Call 'user32::ReleaseDC(p 0, p r1)'
    ${If} $2 < 96
      StrCpy $2 96
    ${EndIf}
    IntOp $alS $2 * 1000
    IntOp $alS $alS / 96

    ; non-client size, and the work area of the monitor the window is on
    System::Call '*(i,i,i,i) p.r1'
    System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r1)'
    System::Call '*$1(i.r2,i.r3,i.r4,i.r5)'
    System::Call 'user32::GetClientRect(p $HWNDPARENT, p r1)'
    System::Call '*$1(i,i,i.r6,i.r7)'
    System::Free $1
    IntOp $4 $4 - $2
    IntOp $5 $5 - $3
    IntOp $4 $4 - $6 ; non-client width
    IntOp $5 $5 - $7 ; non-client height
    System::Call 'user32::MonitorFromWindow(p $HWNDPARENT, i 2) p.r1' ; MONITOR_DEFAULTTONEAREST
    System::Call '*(i 40,i,i,i,i,i,i,i,i,i) p.r2'
    System::Call 'user32::GetMonitorInfoW(p r1, p r2)'
    System::Call '*$2(i,i,i,i,i,i.R0,i.R1,i.R2,i.R3)' ; rcWork
    System::Free $2
    IntOp $0 $R2 - $R0 ; work width
    IntOp $1 $R3 - $R1 ; work height
    ; keep the whole window on screen: shrink the scale if 480 DIP + title bar does not fit, but not below 0.75
    IntOp $2 $1 - 24
    IntOp $2 $2 - $5
    IntOp $2 $2 * 1000
    IntOp $2 $2 / 480
    IntOp $3 $0 - 24
    IntOp $3 $3 - $4
    IntOp $3 $3 * 1000
    IntOp $3 $3 / 720
    IntOp $6 $alS * 750
    IntOp $6 $6 / 1000
    StrCpy $7 $alS
    ${If} $2 < $7
      StrCpy $7 $2
    ${EndIf}
    ${If} $3 < $7
      StrCpy $7 $3
    ${EndIf}
    ${If} $7 < $6
      StrCpy $7 $6
    ${EndIf}
    StrCpy $alS $7
    !insertmacro AL_PX $8 720
    !insertmacro AL_PX $9 480
    IntOp $8 $8 + $4
    IntOp $9 $9 + $5
    IntOp $2 $0 - $8
    IntOp $2 $2 / 2
    IntOp $2 $2 + $R0
    IntOp $3 $1 - $9
    IntOp $3 $3 / 2
    ${If} $3 < 0
      StrCpy $3 0
    ${EndIf}
    IntOp $3 $3 + $R1
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r2, i r3, i r8, i r9, i 0x14)'

    ; fonts (half-DIP sizes)
    !insertmacro AL_FONT $alF11 22 400 "Microsoft YaHei UI"
    !insertmacro AL_FONT $alF12 24 400 "Microsoft YaHei UI"
    !insertmacro AL_FONT $alF13 26 400 "Microsoft YaHei UI"
    !insertmacro AL_FONT $alF13b 26 600 "Microsoft YaHei UI"
    !insertmacro AL_FONT $alF15b 30 600 "Microsoft YaHei UI"
    !insertmacro AL_FONT $alF20b 40 600 "Microsoft YaHei UI"
    !insertmacro AL_FONT $alFm 23 400 "Consolas"
    !insertmacro AL_FONT $alFm10 20 400 "Consolas"
    StrCpy $alDry 0
    StrCpy $alA 0
    Call ${AL_P}alSetMode
    !insertmacro AL_FONT $alFsym 30 400 "Segoe UI Symbol"

    SetCtlColors $HWNDPARENT "${AL_TEXT}" "${AL_PAGE}"

    ; the two page areas (full window / below the header)
    GetDlgItem $0 $HWNDPARENT 1044
    !insertmacro AL_POS $0 0 0 720 432
    GetDlgItem $0 $HWNDPARENT 1018
    !insertmacro AL_POS $0 0 64 720 368

    ; header: one picture across the whole header (face chip baked in), title and subtitle over it
    !insertmacro AL_POS $mui.Header.Background 0 0 720 64
    !insertmacro AL_POS $mui.Header.Image 0 0 720 64
    !insertmacro AL_BOTTOM $mui.Header.Image
    !insertmacro AL_BOTTOM $mui.Header.Background
    !insertmacro AL_POS $mui.Header.Text 86 10 560 20
    !insertmacro AL_POS $mui.Header.SubText 86 34 560 18
    ; the template's header statics and pictures lack WS_CLIPSIBLINGS: without it the background fill paints
    ; over the title, the subtitle and the face chip
    !insertmacro AL_CLIP $mui.Header.Text
    !insertmacro AL_CLIP $mui.Header.SubText
    !insertmacro AL_CLIP $mui.Header.Image
    !insertmacro AL_CLIP $mui.Header.Background
    System::Call 'user32::SetWindowPos(p $mui.Header.Text, p 0, i 0, i 0, i 0, i 0, i 0x13)' ; HWND_TOP
    System::Call 'user32::SetWindowPos(p $mui.Header.SubText, p 0, i 0, i 0, i 0, i 0, i 0x13)'
    SendMessage $mui.Header.Text ${WM_SETFONT} $alF15b 0
    SendMessage $mui.Header.SubText ${WM_SETFONT} $alF12 0
    SetCtlColors $mui.Header.Text "${AL_TITLE}" "${AL_BG}"
    SetCtlColors $mui.Header.SubText "${AL_TEXT2}" "${AL_BG}"

    ; Hairlines: an etched static keeps painting etched after a restyle, so flat lines of our colour take
    ; the place of the header line (1036) and the full-width bar line (1045). The short bar line that MUI
    ; shows on inner pages (1035) goes away; the full-width one shows on every page.
    GetDlgItem $0 $HWNDPARENT 1036
    !insertmacro AL_POS $0 0 63 720 1
    GetDlgItem $0 $HWNDPARENT 1045
    !insertmacro AL_POS $0 0 432 720 1
    StrCpy $alA 1036
    Call ${AL_P}alFlatLine
    StrCpy $alA 1045
    Call ${AL_P}alFlatLine
    System::Call 'user32::SetWindowPos(p $mui.Line.Standard, p 0, i 0, i -100, i 0, i 0, i 0x15)' ; off-screen

    ; Buttons: dark theme, painted on the bar colour (else a light square shows around the rounded face).
    ; Branding text: in the button bar, left of the buttons. MUI's branding "background" twin is only there
    ; to break the old line, so it goes off-screen.
    System::Call 'uxtheme::SetWindowTheme(p $mui.Button.Next, w "DarkMode_Explorer", p 0)'
    System::Call 'uxtheme::SetWindowTheme(p $mui.Button.Back, w "DarkMode_Explorer", p 0)'
    System::Call 'uxtheme::SetWindowTheme(p $mui.Button.Cancel, w "DarkMode_Explorer", p 0)'
    SetCtlColors $mui.Button.Next "${AL_TEXT}" "${AL_PAGE}"
    SetCtlColors $mui.Button.Back "${AL_TEXT}" "${AL_PAGE}"
    SetCtlColors $mui.Button.Cancel "${AL_TEXT}" "${AL_PAGE}"
    SendMessage $mui.Button.Next ${WM_SETFONT} $alF12 0
    SendMessage $mui.Button.Back ${WM_SETFONT} $alF12 0
    SendMessage $mui.Button.Cancel ${WM_SETFONT} $alF12 0
    !insertmacro AL_BAR "返回" "下一步" 96 "取消"
    System::Call 'user32::SetWindowPos(p $mui.Branding.Background, p 0, i 0, i -100, i 0, i 0, i 0x15)'
    EnableWindow $mui.Branding.Text 1 ; a disabled static ignores its colours
    SetCtlColors $mui.Branding.Text "${AL_TEXT3}" "${AL_PAGE}"
    SendMessage $mui.Branding.Text ${WM_SETFONT} $alF11 0
    !insertmacro AL_POS $mui.Branding.Text 16 448 360 16 ; ends before the Back button of the widest button row (388)

    StrCpy $alA $mui.Header.Image
    StrCpy $alB "$PLUGINSDIR\modern-header.bmp"
    Call ${AL_P}alSetImg
  FunctionEnd

  ; Inner pages that only exist as electron-builder's install-mode page (never shown for us): colour the
  ; page dialog and its text controls so a stray appearance is not a white square.
  Function ${AL_P}alDarkPage
    Push $0
    Push $1
    FindWindow $0 "#32770" "" $HWNDPARENT
    ${If} $0 != 0
      SetCtlColors $0 "${AL_TEXT}" "${AL_PAGE}"
      StrCpy $1 0
      ${Do}
        FindWindow $1 "" "" $0 $1
        ${If} $1 == 0
          ${ExitDo}
        ${EndIf}
        SetCtlColors $1 "${AL_TEXT}" "${AL_PAGE}"
      ${Loop}
    ${EndIf}
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = size in whole KB, $alB = the bytes beyond that (0..1023) -> $alR "812 字节" / "312 KB" / "9.7 MB" / "1.2 GB"
  Function ${AL_P}alFmtSize
    Push $0
    Push $1
    ${If} $alA < 1
      StrCpy $alR "$alB 字节"
    ${ElseIf} $alA < 1024
      StrCpy $0 $alA
      ${If} $alB >= 512
        IntOp $0 $0 + 1
      ${EndIf}
      StrCpy $alR "$0 KB"
    ${ElseIf} $alA < 1048576
      IntOp $0 $alA / 1024
      IntOp $1 $alA % 1024
      IntOp $1 $1 * 10
      IntOp $1 $1 / 1024
      StrCpy $alR "$0.$1 MB"
    ${Else}
      IntOp $0 $alA / 1048576
      IntOp $1 $alA % 1048576
      IntOp $1 $1 * 10
      IntOp $1 $1 / 1048576
      StrCpy $alR "$0.$1 GB"
    ${EndIf}
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = tier (0..3) -> $alMode, and the line height and row gap (DIP) that go with it
  Function ${AL_P}alSetMode
    StrCpy $alMode $alA
    ${If} $alMode = 0
      StrCpy $alLH 15
      StrCpy $alGap 6
    ${Else}
      StrCpy $alLH 13
      StrCpy $alGap 4
    ${EndIf}
  FunctionEnd

  ; $alA = a path, $alC = width (DIP) -> $alR = the path shortened for the small monospace font, $alN = its lines.
  ; Whatever is left out is marked with "…". The drive (or \\server\) always stays, and so does the name of the last
  ; folder or file, in full: first as many of the last folders as fit on ONE line (G:\…\parent\last), then only
  ; the last name (G:\…\last). If even that does not fit the last name goes on lines of its own under "G:\…\", all
  ; its characters kept, so two files in the same folder can still be told apart. The full path is what the "copy"
  ; button beside it puts on the clipboard.
  Function ${AL_P}alPathCompact
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9
    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    IntOp $0 $alC * $alS
    IntOp $0 $0 / 1000
    IntOp $0 $0 - 2
    StrCpy $4 $alA
    System::Call 'user32::GetDC(p 0) p.r1'
    System::Call 'gdi32::SelectObject(p r1, p $alFm10) p.r2'
    System::Call '*(i 0, i 0) p.r3'
    StrCpy $alR $4
    StrLen $5 $4
    StrCpy $alN 1
    System::Call 'gdi32::GetTextExtentExPointW(p r1, w "$4", i r5, i r0, *i .r6, p 0, p r3) i.R4'
    ${If} $6 < $5
      ; $9 = the first backslash (after a leading \\), the end of the head
      StrCpy $9 0
      StrCpy $R1 $4 2
      ${If} $R1 == "\\"
        StrCpy $9 2
      ${EndIf}
      ${Do}
        StrCpy $R1 $4 1 $9
        ${If} $R1 == "\"
        ${OrIf} $R1 == ""
          ${ExitDo}
        ${EndIf}
        IntOp $9 $9 + 1
      ${Loop}
      ; $7 = the last backslash (-1 when there is no folder below the head)
      StrCpy $7 -1
      IntOp $8 $5 - 1
      ${Do}
        ${If} $8 <= $9
          ${ExitDo}
        ${EndIf}
        StrCpy $R1 $4 1 $8
        ${If} $R1 == "\"
          StrCpy $7 $8
          ${ExitDo}
        ${EndIf}
        IntOp $8 $8 - 1
      ${Loop}
      IntOp $R2 $9 + 1
      StrCpy $R0 $4 $R2        ; the head, with its backslash
      StrCpy $R3 0             ; 1 = a one-line form fits
      ${If} $7 > $9
        ; the longest tail first: drop the first folder, then two, ... down to the last name alone
        IntOp $8 $9 + 1
        ${Do}
          ${If} $8 > $7
            ${ExitDo}
          ${EndIf}
          StrCpy $R1 $4 1 $8
          ${If} $R1 == "\"
            StrCpy $R2 $4 "" $8
            StrCpy $alR "$R0…$R2"
            StrLen $5 $alR
            System::Call 'gdi32::GetTextExtentExPointW(p r1, w "$alR", i r5, i r0, *i .r6, p 0, p r3) i.R4'
            ${If} $6 >= $5
              StrCpy $R3 1
              ${ExitDo}
            ${EndIf}
          ${EndIf}
          IntOp $8 $8 + 1
        ${Loop}
      ${EndIf}
      ${If} $R3 = 0
        ${If} $7 > $9
          ; "G:\…\" on a line of its own, then the last name on the lines it needs
          StrCpy $alR "$R0…\"
          IntOp $8 $7 + 1
          StrCpy $R2 $4 "" $8
          StrCpy $alN 1
        ${Else}
          ; nothing to leave out (a name right under the drive): all of it, in lines
          StrCpy $alR ""
          StrCpy $R2 $4
          StrCpy $alN 0
        ${EndIf}
        ${Do}
          StrLen $5 $R2
          ${If} $5 = 0
            ${ExitDo}
          ${EndIf}
          System::Call 'gdi32::GetTextExtentExPointW(p r1, w "$R2", i r5, i r0, *i .r6, p 0, p r3) i.R4'
          ${If} $6 < 1
            StrCpy $6 1
          ${EndIf}
          StrCpy $R1 $R2 $6
          StrCpy $R2 $R2 "" $6
          ${If} $alN > 0
            StrCpy $alR "$alR$\r$\n$R1"
          ${Else}
            StrCpy $alR $R1
          ${EndIf}
          IntOp $alN $alN + 1
        ${Loop}
      ${EndIf}
    ${EndIf}
    System::Free $3
    System::Call 'gdi32::SelectObject(p r1, p r2)'
    System::Call 'user32::ReleaseDC(p 0, p r1)'
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    Pop $9
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = a check box (button) that has been dressed by AL_CHKDRESS: show its state in the glyph beside it
  ; (the installer has such a box only when the finish page has its "run" box)
  !ifdef BUILD_UNINSTALLER | AL_SHOW_RUN
  Function ${AL_P}alChkSync
    Push $0
    Push $1
    System::Call 'user32::GetPropW(p $alA, w "alg") p.r1'
    SendMessage $alA ${BM_GETCHECK} 0 0 $0
    ${If} $1 <> 0
      ${If} $0 == ${BST_CHECKED}
        SendMessage $1 ${WM_SETTEXT} 0 "STR:☑"
      ${Else}
        SendMessage $1 ${WM_SETTEXT} 0 "STR:☐"
      ${EndIf}
    ${EndIf}
    Pop $1
    Pop $0
  FunctionEnd
  !endif

  ; The full text a "copy" button puts on the clipboard travels with the button as a window property: $alA = the
  ; button, $alB = the text
  Function ${AL_P}alCopyTag
    Push $0
    Push $1
    StrLen $0 $alB
    IntOp $0 $0 + 1
    IntOp $0 $0 * 2
    System::Alloc $0
    Pop $1
    System::Call 'kernel32::lstrcpyW(p r1, w "$alB")'
    System::Call 'user32::SetPropW(p $alA, w "alp", p r1)'
    Pop $1
    Pop $0
  FunctionEnd

  ; the "copy" buttons (nsDialogs click callback: the button is on the stack): the text the button carries, or
  ; $alCopy (the "copy all paths" button), to the clipboard
  Function ${AL_P}alCopyClick
    Pop $0
    !ifdef BUILD_UNINSTALLER
      StrCpy $7 $alCopy
    !else
      StrCpy $7 ""
    !endif
    System::Call 'user32::GetPropW(p r0, w "alp") p.r6'
    ${If} $6 <> 0
      System::Call 'kernel32::lstrcpyW(w .r7, p r6)'
    ${EndIf}
    StrLen $1 $7
    IntOp $1 $1 + 1
    IntOp $1 $1 * 2
    System::Call 'kernel32::GlobalAlloc(i 0x42, p r1) p.r2' ; GMEM_MOVEABLE | GMEM_ZEROINIT
    ${If} $2 <> 0
      System::Call 'kernel32::GlobalLock(p r2) p.r3'
      System::Call 'kernel32::lstrcpyW(p r3, w "$7")'
      System::Call 'kernel32::GlobalUnlock(p r2)'
      System::Call 'user32::OpenClipboard(p $HWNDPARENT) i.r4'
      ${If} $4 <> 0
        System::Call 'user32::EmptyClipboard()'
        System::Call 'user32::SetClipboardData(i 13, p r2) p.r5' ; CF_UNICODETEXT
        System::Call 'user32::CloseClipboard()'
        ${If} $5 = 0
          System::Call 'kernel32::GlobalFree(p r2)'
        ${Else}
          SendMessage $0 ${WM_SETTEXT} 0 "STR:已复制"
        ${EndIf}
      ${Else}
        System::Call 'kernel32::GlobalFree(p r2)'
      ${EndIf}
    ${EndIf}
  FunctionEnd

  ; ---- breaking a text into lines ------------------------------------------------------------------------
  ; The skin breaks its running texts itself (a wrapping static breaks anywhere between two Chinese characters and
  ; splits words like 自定义 / 文件 / 默认, and the old "balancing" left a third of the column empty). alTextH
  ; measures with the real font, breaks at the whole width, and hands the page the lines (CRLF) for a no-wrap static.
  ; A break may not come: before a closing mark or after an opening one, inside a run of Latin letters / digits /
  ; dots, between a number and its unit (3.0 / MB, 10 / 个文件), or inside a word of the small word list in alBrk. A
  ; break at a space, after a punctuation mark or between Latin and Chinese is preferred within the last third of
  ; the line; only if there is none does it fall between two Chinese characters that are not a word.

  ; $alBT = a text, $alBP = a position in it (1 .. length-1: between the characters before and at it)
  ; -> $alBR 0 = no line may end here, 1 = possible, 2 = a good place
  Function ${AL_P}alBrk
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    StrCpy $alBR 0
    IntOp $0 $alBP - 1
    StrCpy $1 $alBT 1 $0       ; the character before the break
    StrCpy $2 $alBT 1 $alBP    ; the character after it
    ; a line may not start with a closing mark
    ${If} $2 == "，"
    ${OrIf} $2 == "。"
    ${OrIf} $2 == "、"
    ${OrIf} $2 == "；"
    ${OrIf} $2 == "："
    ${OrIf} $2 == "！"
    ${OrIf} $2 == "？"
    ${OrIf} $2 == "）"
    ${OrIf} $2 == "」"
    ${OrIf} $2 == "』"
    ${OrIf} $2 == "》"
    ${OrIf} $2 == "】"
    ${OrIf} $2 == "…"
    ${OrIf} $2 == "”"
    ${OrIf} $2 == "’"
    ${OrIf} $2 == ","
    ${OrIf} $2 == "."
    ${OrIf} $2 == ";"
    ${OrIf} $2 == ":"
    ${OrIf} $2 == "!"
    ${OrIf} $2 == "?"
    ${OrIf} $2 == ")"
    ${OrIf} $2 == "]"
      Goto alb_no
    ${EndIf}
    ; and may not end with an opening one
    ${If} $1 == "（"
    ${OrIf} $1 == "「"
    ${OrIf} $1 == "『"
    ${OrIf} $1 == "《"
    ${OrIf} $1 == "【"
    ${OrIf} $1 == "“"
    ${OrIf} $1 == "‘"
    ${OrIf} $1 == "("
    ${OrIf} $1 == "["
      Goto alb_no
    ${EndIf}
    ; at a space: fine, unless it is the one between a number and its unit
    ${If} $1 == " "
    ${OrIf} $2 == " "
      StrCpy $4 $1
      ${If} $1 == " "
        StrCpy $4 ""
        ${If} $0 >= 1
          IntOp $5 $0 - 1
          StrCpy $4 $alBT 1 $5
        ${EndIf}
      ${EndIf}
      ${If} $4 == "0"
      ${OrIf} $4 == "1"
      ${OrIf} $4 == "2"
      ${OrIf} $4 == "3"
      ${OrIf} $4 == "4"
      ${OrIf} $4 == "5"
      ${OrIf} $4 == "6"
      ${OrIf} $4 == "7"
      ${OrIf} $4 == "8"
      ${OrIf} $4 == "9"
        Goto alb_no
      ${EndIf}
      Goto alb_good
    ${EndIf}
    ; after a mark that ends a clause
    ${If} $1 == "，"
    ${OrIf} $1 == "。"
    ${OrIf} $1 == "、"
    ${OrIf} $1 == "；"
    ${OrIf} $1 == "："
    ${OrIf} $1 == "！"
    ${OrIf} $1 == "？"
    ${OrIf} $1 == "）"
    ${OrIf} $1 == "」"
    ${OrIf} $1 == "』"
    ${OrIf} $1 == "》"
    ${OrIf} $1 == "】"
    ${OrIf} $1 == "…"
    ${OrIf} $1 == "”"
    ${OrIf} $1 == "’"
    ${OrIf} $1 == ","
    ${OrIf} $1 == ";"
    ${OrIf} $1 == ")"
      Goto alb_good
    ${EndIf}
    ; the rest needs to know which side is Latin: character codes (the scratch buffer at +16)
    IntOp $4 $alWsz + 16
    System::Call 'kernel32::lstrcpyW(p r4, w "$1")'
    System::Call '*$4(&i2 .r5)'
    StrCpy $0 0                ; $0 = the character before is a Latin letter / digit / sign
    ${If} $5 > 32
    ${AndIf} $5 < 127
      StrCpy $0 1
    ${EndIf}
    System::Call 'kernel32::lstrcpyW(p r4, w "$2")'
    System::Call '*$4(&i2 .r5)'
    StrCpy $3 0                ; $3 = the one after it is
    ${If} $5 > 32
    ${AndIf} $5 < 127
      StrCpy $3 1
    ${EndIf}
    ${If} $0 = 1
    ${AndIf} $3 = 1
      Goto alb_no              ; inside a run: alight.db-wal, KB, 3.0
    ${EndIf}
    ${If} $0 = 1
    ${OrIf} $3 = 1
      ; Latin meets Chinese: fine, unless a digit is cut from its unit (3 个)
      ${If} $0 = 1
        ${If} $1 == "0"
        ${OrIf} $1 == "1"
        ${OrIf} $1 == "2"
        ${OrIf} $1 == "3"
        ${OrIf} $1 == "4"
        ${OrIf} $1 == "5"
        ${OrIf} $1 == "6"
        ${OrIf} $1 == "7"
        ${OrIf} $1 == "8"
        ${OrIf} $1 == "9"
          Goto alb_no
        ${EndIf}
      ${EndIf}
      Goto alb_good
    ${EndIf}
    ; between two Chinese characters: possible, unless they belong to one of the words
    StrCpy $alBR 1
    !insertmacro AL_PROT4 "快捷方式"
    !insertmacro AL_PROT4 "开始菜单"
    !insertmacro AL_PROT3 "自定义"
    !insertmacro AL_PROT3 "文件夹"
    !insertmacro AL_PROT3 "服务商"
    !insertmacro AL_PROT3 "回收站"
    !insertmacro AL_PROT3 "便携版"
    !insertmacro AL_PROT3 "浏览器"
    !insertmacro AL_PROT3 "管理员"
    !insertmacro AL_PROT3 "命令行"
    !insertmacro AL_PROT3 "任务栏"
    !insertmacro AL_PROT2 "文件"
    !insertmacro AL_PROT2 "默认"
    !insertmacro AL_PROT2 "删除"
    !insertmacro AL_PROT2 "数据"
    !insertmacro AL_PROT2 "目录"
    !insertmacro AL_PROT2 "设置"
    !insertmacro AL_PROT2 "缓存"
    !insertmacro AL_PROT2 "密钥"
    !insertmacro AL_PROT2 "登录"
    !insertmacro AL_PROT2 "状态"
    !insertmacro AL_PROT2 "程序"
    !insertmacro AL_PROT2 "无法"
    !insertmacro AL_PROT2 "恢复"
    !insertmacro AL_PROT2 "重新"
    !insertmacro AL_PROT2 "安装"
    !insertmacro AL_PROT2 "卸载"
    !insertmacro AL_PROT2 "保留"
    !insertmacro AL_PROT2 "对话"
    !insertmacro AL_PROT2 "任务"
    !insertmacro AL_PROT2 "记录"
    !insertmacro AL_PROT2 "技能"
    !insertmacro AL_PROT2 "练习"
    !insertmacro AL_PROT2 "偏好"
    !insertmacro AL_PROT2 "窗口"
    !insertmacro AL_PROT2 "位置"
    !insertmacro AL_PROT2 "工作"
    !insertmacro AL_PROT2 "备份"
    !insertmacro AL_PROT2 "工具"
    !insertmacro AL_PROT2 "作废"
    !insertmacro AL_PROT2 "页面"
    !insertmacro AL_PROT2 "栖枝"
    !insertmacro AL_PROT2 "遐蝶"
    !insertmacro AL_PROT2 "没有"
    !insertmacro AL_PROT2 "改动"
    !insertmacro AL_PROT2 "占用"
    !insertmacro AL_PROT2 "关闭"
    !insertmacro AL_PROT2 "手动"
    !insertmacro AL_PROT2 "其他"
    !insertmacro AL_PROT2 "其余"
    !insertmacro AL_PROT2 "版本"
    !insertmacro AL_PROT2 "已经"
    !insertmacro AL_PROT2 "退出"
    !insertmacro AL_PROT2 "检测"
    !insertmacro AL_PROT2 "运行"
    !insertmacro AL_PROT2 "进程"
    !insertmacro AL_PROT2 "托盘"
    !insertmacro AL_PROT2 "官方"
    !insertmacro AL_PROT2 "同人"
    !insertmacro AL_PROT2 "空间"
    !insertmacro AL_PROT2 "大小"
    !insertmacro AL_PROT2 "同意"
    !insertmacro AL_PROT2 "永久"
    !insertmacro AL_PROT2 "核对"
    !insertmacro AL_PROT2 "更新"
    !insertmacro AL_PROT2 "替换"
    !insertmacro AL_PROT2 "接上"
    !insertmacro AL_PROT2 "原样"
    !insertmacro AL_PROT2 "原处"
    !insertmacro AL_PROT2 "路径"
    !insertmacro AL_PROT2 "过长"
    !insertmacro AL_PROT2 "服务"
    !insertmacro AL_PROT2 "环境"
    !insertmacro AL_PROT2 "变量"
    !insertmacro AL_PROT2 "进行"
    !insertmacro AL_PROT2 "等待"
    Goto alb_end
    alb_good:
    StrCpy $alBR 2
    Goto alb_end
    alb_no:
    StrCpy $alBR 0
    alb_end:
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = a text, $alWpx = the width (px), $alWdc = a DC with the font selected, $alWsz = the scratch buffer
  ; -> $alWT = the text broken into lines (CRLF), $alN = the number of lines, $alWL = the length of the last line
  Function ${AL_P}alWrapRun
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9
    Push $R0
    StrCpy $R0 $alA
    StrCpy $alWT ""
    StrCpy $alN 0
    StrCpy $alWL 0
    ${Do}
      StrLen $1 $R0
      ${If} $1 = 0
        ${ExitDo}
      ${EndIf}
      System::Call 'gdi32::GetTextExtentExPointW(p $alWdc, w "$R0", i r1, i $alWpx, *i .r2, p 0, p $alWsz) i.r3'
      ${If} $2 >= $1
        StrCpy $4 $R0
        StrCpy $R0 ""
      ${Else}
        ${If} $2 < 1
          StrCpy $2 1
        ${EndIf}
        StrCpy $alBT $R0
        StrCpy $5 0              ; the first place where a line may end, from the right
        StrCpy $6 0              ; a good place
        IntOp $7 $2 / 3
        ${If} $7 < 3
          StrCpy $7 3
        ${EndIf}
        IntOp $7 $2 - $7         ; a good place is looked for down to here
        ${If} $7 < 1
          StrCpy $7 1
        ${EndIf}
        IntOp $8 $7 - 8          ; and a possible one a little further
        ${If} $8 < 1
          StrCpy $8 1
        ${EndIf}
        StrCpy $9 $2
        ${Do}
          ${If} $9 < $8
            ${ExitDo}
          ${EndIf}
          ${If} $9 < $7
          ${AndIf} $5 <> 0
            ${ExitDo}
          ${EndIf}
          StrCpy $alBP $9
          Call ${AL_P}alBrk
          ${If} $alBR = 2
            StrCpy $6 $9
            ${ExitDo}
          ${ElseIf} $alBR = 1
          ${AndIf} $5 = 0
            StrCpy $5 $9
          ${EndIf}
          IntOp $9 $9 - 1
        ${Loop}
        ${If} $6 = 0
          StrCpy $6 $5
        ${EndIf}
        ${If} $6 = 0
          StrCpy $6 $2           ; nothing allowed: the width decides
        ${EndIf}
        StrCpy $4 $R0 $6
        StrCpy $R0 $R0 "" $6
        ${Do}                    ; the spaces at the break go
          StrCpy $3 $4 1 -1
          ${If} $3 == " "
            StrCpy $4 $4 -1
          ${Else}
            ${ExitDo}
          ${EndIf}
        ${Loop}
        ${Do}
          StrCpy $3 $R0 1
          ${If} $3 == " "
            StrCpy $R0 $R0 "" 1
          ${Else}
            ${ExitDo}
          ${EndIf}
        ${Loop}
      ${EndIf}
      ${If} $alN > 0
        StrCpy $alWT "$alWT$\r$\n$4"
      ${Else}
        StrCpy $alWT $4
      ${EndIf}
      IntOp $alN $alN + 1
      StrLen $alWL $4
    ${Loop}
    ${If} $alN = 0
      StrCpy $alN 1
    ${EndIf}
    Pop $R0
    Pop $9
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = text, $alB = HFONT, $alC = width (DIP) -> $alWT = the text broken into lines (CRLF) to put into a no-wrap
  ; static, $alN = the number of lines, $alR = the height (DIP, rounded up) of those lines in that font. The lines use the
  ; whole width; only when the last line would be a few characters (an orphan) are the lines made a little narrower,
  ; as long as that does not add a line.
  Function ${AL_P}alTextH
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    IntOp $0 $alC * $alS
    IntOp $0 $0 / 1000
    IntOp $0 $0 - 3          ; the drawn text can come out a pixel or two wider than it measures
    System::Call 'user32::GetDC(p 0) p.r1'
    System::Call 'gdi32::SelectObject(p r1, p $alB) p.r2'
    System::Alloc 32
    Pop $3
    StrCpy $alWdc $1
    StrCpy $alWsz $3
    StrCpy $alWpx $0
    Call ${AL_P}alWrapRun
    ${If} $alN >= 2
    ${AndIf} $alWL < 4
      StrCpy $4 $alN
      StrCpy $5 1
      ${Do}
        IntOp $6 $alS * 8
        IntOp $6 $6 * $5
        IntOp $6 $6 / 1000
        IntOp $alWpx $0 - $6
        Call ${AL_P}alWrapRun
        ${If} $alN > $4
          StrCpy $alWpx $0
          Call ${AL_P}alWrapRun
          ${ExitDo}
        ${EndIf}
        ${If} $alWL >= 4
          ${ExitDo}
        ${EndIf}
        IntOp $5 $5 + 1
        ${If} $5 > 8
          StrCpy $alWpx $0
          Call ${AL_P}alWrapRun
          ${ExitDo}
        ${EndIf}
      ${Loop}
    ${EndIf}
    System::Call '*(i 0, i 0, i 100000, i 0) p.r6'
    System::Call 'user32::DrawTextW(p r1, w "$alWT", i -1, p r6, i 0x0C00)' ; DT_CALCRECT | DT_NOPREFIX
    System::Call '*$6(i, i, i, i .r7)'
    System::Free $6
    System::Call 'gdi32::SelectObject(p r1, p r2)'
    System::Call 'user32::ReleaseDC(p 0, p r1)'
    System::Free $3
    IntOp $7 $7 * 1000
    IntOp $7 $7 + $alS
    IntOp $7 $7 - 1
    IntOp $alR $7 / $alS
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = a path (or a line that ends in one), $alC = width (DIP) -> $alR = the text broken into lines (CRLF)
  ; that each fit that width in the monospace font, $alN = the number of lines. A line is broken after a
  ; backslash when there is one in its second half, else where the width ends. Nothing is cut off.
  Function ${AL_P}alPathWrap
    ${If} $alMode >= 2
      Call ${AL_P}alPathCompact
      Return
    ${EndIf}
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    Push $8
    Push $9
    Push $R0
    Push $R1
    IntOp $0 $alC * $alS
    IntOp $0 $0 / 1000
    IntOp $0 $0 - 2
    System::Call 'user32::GetDC(p 0) p.r1'
    StrCpy $R0 $alFm
    ${If} $alMode = 1
      StrCpy $R0 $alFm10
    ${EndIf}
    System::Call 'gdi32::SelectObject(p r1, p R0) p.r2'
    System::Call '*(i 0, i 0) p.r3'
    StrCpy $4 $alA
    StrCpy $alR ""
    StrCpy $alN 0
    ${Do}
      StrLen $5 $4
      ${If} $5 = 0
        ${ExitDo}
      ${EndIf}
      System::Call 'gdi32::GetTextExtentExPointW(p r1, w "$4", i r5, i r0, *i .r6, p 0, p r3) i.r7'
      ${If} $6 >= $5
        StrCpy $7 $4
        StrCpy $4 ""
      ${Else}
        ${If} $6 < 1
          StrCpy $6 1
        ${EndIf}
        StrCpy $8 $6
        IntOp $9 $6 / 2
        ${Do}
          ${If} $8 <= $9
            StrCpy $8 $6
            ${ExitDo}
          ${EndIf}
          IntOp $R0 $8 - 1
          StrCpy $R1 $4 1 $R0
          ${If} $R1 == "\"
            ${ExitDo}
          ${EndIf}
          IntOp $8 $8 - 1
        ${Loop}
        StrCpy $7 $4 $8
        StrCpy $4 $4 "" $8
      ${EndIf}
      ${If} $alN > 0
        StrCpy $alR "$alR$\r$\n$7"
      ${Else}
        StrCpy $alR $7
      ${EndIf}
      IntOp $alN $alN + 1
    ${Loop}
    ${If} $alN = 0
      StrCpy $alN 1
    ${EndIf}
    System::Free $3
    System::Call 'gdi32::SelectObject(p r1, p r2)'
    System::Call 'user32::ReleaseDC(p 0, p r1)'
    Pop $R1
    Pop $R0
    Pop $9
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = haystack, $alB = needle -> $alR = index of the first match, or -1
  Function ${AL_P}alIndexOf
    Push $0
    Push $1
    Push $2
    Push $3
    StrLen $0 $alA
    StrLen $1 $alB
    StrCpy $2 0
    StrCpy $alR -1
    ${If} $1 > 0
      ${Do}
        IntOp $3 $2 + $1
        ${If} $3 > $0
          ${ExitDo}
        ${EndIf}
        StrCpy $3 $alA $1 $2
        ${If} $3 == $alB
          StrCpy $alR $2
          ${ExitDo}
        ${EndIf}
        IntOp $2 $2 + 1
      ${Loop}
    ${EndIf}
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = a PowerShell expression -> $alR = its text result (first line), or "" when PowerShell is not
  ; there / blocked. The result goes through a UTF-16 file (no BOM): NSIS reads that back without the
  ; code page mangling Chinese paths would get from the console.
  Function ${AL_P}alPsOut
    Push $0
    Push $1
    InitPluginsDir
    StrCpy $alR ""
    Delete "$PLUGINSDIR\alps.txt"
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "[IO.File]::WriteAllBytes('$PLUGINSDIR\alps.txt',[Text.Encoding]::Unicode.GetBytes([string](& { $alA })))"`
    Pop $0
    ClearErrors
    FileOpen $0 "$PLUGINSDIR\alps.txt" r
    ${IfNot} ${Errors}
      FileReadUTF16LE $0 $1
      FileClose $0
      StrCpy $alR $1
      ; trim a trailing CR / LF
      ${Do}
        StrCpy $0 $alR 1 -1
        ${If} $0 == "$\r"
        ${OrIf} $0 == "$\n"
          StrCpy $alR $alR -1
        ${Else}
          ${ExitDo}
        ${EndIf}
      ${Loop}
    ${EndIf}
    Delete "$PLUGINSDIR\alps.txt"
    Pop $1
    Pop $0
  FunctionEnd

  ; Push <directory>, Call: add the file sizes (exact: $alAccKB whole KB + $alAccR bytes) and count under it to
  ; $alAccN. Entries that
  ; are reparse points (junctions, symlinks) are skipped, never followed.
  Function ${AL_P}alWalk
    Exch $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    Push $7
    System::Alloc 592 ; WIN32_FIND_DATAW
    Pop $1
    ; the long-path form (backslash backslash question mark backslash) lifts the 260 character limit, and a deep
    ; tree under a practice folder is real; a path that is already UNC goes as it is
    StrCpy $2 $0 2
    ${If} $2 == "\\"
      StrCpy $2 $0
    ${Else}
      StrCpy $2 "\\?\$0"
    ${EndIf}
    System::Call 'kernel32::FindFirstFileW(w "$2\*", p r1) i.r2'
    ${If} $2 <> -1
    ${AndIf} $2 <> 0
      ${Do}
        System::Call '*$1(i.r3, l, l, l, i.r4, i.r5, i, i, &w260.r6)' ; attributes, size high / low, name
        ${If} $6 != "."
        ${AndIf} $6 != ".."
          IntOp $7 $3 & 0x400
          ${If} $7 = 0
            IntOp $7 $3 & 0x10
            ${If} $7 <> 0
              Push "$0\$6"
              Call ${AL_P}alWalk
            ${Else}
              ; real size: whole KB in alAccKB, the bytes below a KB in alAccR (carried over at 1024)
              IntOp $7 $5 & 1023
              IntOp $5 $5 >>> 10
              IntOp $4 $4 * 4194304
              IntOp $5 $5 + $4
              IntOp $alAccKB $alAccKB + $5
              IntOp $alAccR $alAccR + $7
              ${If} $alAccR >= 1024
                IntOp $alAccR $alAccR - 1024
                IntOp $alAccKB $alAccKB + 1
              ${EndIf}
              IntOp $alAccN $alAccN + 1
            ${EndIf}
          ${EndIf}
        ${EndIf}
        System::Call 'kernel32::FindNextFileW(i r2, p r1) i.r3'
        ${If} $3 = 0
          ${ExitDo}
        ${EndIf}
      ${Loop}
      System::Call 'kernel32::FindClose(i r2)'
    ${EndIf}
    System::Free $1
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = path (file or folder): add its size to $alAccKB / $alAccR / $alAccN and set $alAccE = 1 when it exists
  ; (a reparse point at the top counts as not there)
  Function ${AL_P}alAddKB
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    System::Call 'kernel32::GetFileAttributesW(w "$alA") i.r0'
    ${If} $0 <> -1
      IntOp $1 $0 & 0x400
      ${If} $1 = 0
        StrCpy $alAccE 1
        IntOp $1 $0 & 0x10
        ${If} $1 <> 0
          Push $alA
          Call ${AL_P}alWalk
        ${Else}
          System::Alloc 592
          Pop $2
          System::Call 'kernel32::FindFirstFileW(w "$alA", p r2) i.r3'
          ${If} $3 <> -1
          ${AndIf} $3 <> 0
            System::Call '*$2(i, l, l, l, i.r4, i.r5)'
            System::Call 'kernel32::FindClose(i r3)'
            IntOp $1 $5 & 1023
            IntOp $5 $5 >>> 10
            IntOp $4 $4 * 4194304
            IntOp $5 $5 + $4
            IntOp $alAccKB $alAccKB + $5
            IntOp $alAccR $alAccR + $1
            ${If} $alAccR >= 1024
              IntOp $alAccR $alAccR - 1024
              IntOp $alAccKB $alAccKB + 1
            ${EndIf}
            IntOp $alAccN $alAccN + 1
          ${EndIf}
          System::Free $2
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
!macroend

; ---------------------------------------------------------------------------------------------------
; the "is the app running" page. Shared by the installer and the uninstaller; matches by process name
; (never by path: before the files page $INSTDIR is still the parent folder the user picked).
; ---------------------------------------------------------------------------------------------------
!macro AL_RUNPAGE TITLE SUB HEAD BODY BTN
  Var alRunMsg
  Var alRunBtn
  Var alRunHead ; the parts of the warning block, rewritten when a re-check finds the app gone
  Var alRunL1
  Var alRunProc
  Var alRunBody
  Var alRunBar
  Var alRunIcon
  Var alRunBlk
  Var alRunHint
  Var alRunBT   ; the body text, broken into lines

  Function ${AL_P}alRunPre
    ${If} ${Silent}
    ${OrIf} ${isUpdated}
    !ifndef BUILD_UNINSTALLER
    ${OrIf} ${UAC_IsInnerInstance}
    !endif
      Abort
    ${EndIf}
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $0
    ${If} $0 != 0
      Abort
    ${EndIf}

    ; what is running: count and folder (the name alone when PowerShell does not answer)
    StrCpy $alA "$$p=@(Get-Process -Name '${PRODUCT_FILENAME}' -ErrorAction SilentlyContinue); $$d=''; if ($$p.Count -gt 0) { try { $$d = Split-Path -Parent ([string]$$p[0].Path) } catch { } }; [string]$$p.Count + '|' + $$d"
    Call ${AL_P}alPsOut
    StrCpy $alA $alR
    StrCpy $alB "|"
    Call ${AL_P}alIndexOf
    StrCpy $2 "${APP_EXECUTABLE_FILENAME}，正在运行"
    ${If} $alR > 0
      StrCpy $3 $alA $alR
      IntOp $4 $alR + 1
      StrCpy $5 $alA "" $4
      ${If} $3 > 0
        ${If} $5 != ""
          StrCpy $2 "${APP_EXECUTABLE_FILENAME}，$3 个进程，位于 $5"
        ${Else}
          StrCpy $2 "${APP_EXECUTABLE_FILENAME}，$3 个进程"
        ${EndIf}
      ${EndIf}
    ${EndIf}

    ; sizes first: the process line (broken onto as many lines as it needs) and the body text decide the
    ; height of the block, and what sits under it moves with it
    StrCpy $alA "$2"
    StrCpy $alC 604
    Call ${AL_P}alPathWrap
    StrCpy $6 $alR
    IntOp $7 $alN * 15
    StrCpy $alA "${BODY}"
    StrCpy $alB $alF12
    StrCpy $alC 604
    Call ${AL_P}alTextH
    StrCpy $8 $alR
    StrCpy $alRunBT $alWT
    IntOp $9 74 + $7
    IntOp $9 $9 + 8
    IntOp $4 $9 + $8
    IntOp $4 $4 - 6 ; block height: from y 20 to the body's end + 14

    !insertmacro MUI_HEADER_TEXT "${TITLE}" "${SUB}"
    nsDialogs::Create 1018
    Pop $alDlg
    ${If} $alDlg == error
      Abort
    ${EndIf}
    SetCtlColors $alDlg "${AL_TEXT}" "${AL_PAGE}"

    ; the gold-edged block
    !insertmacro AL_LBL $alRunBlk $alDlg 24 20 672 $4 ${AL_SS_FILL} "" "${AL_FIELD}" "${AL_FIELD}" ""
    !insertmacro AL_LBL $alRunBar $alDlg 24 20 3 $4 ${AL_SS_FILL} "" "${AL_GOLD}" "${AL_GOLD}" ""
    !insertmacro AL_BMP $alRunIcon $alDlg warn_gold.bmp 36 31 18 18 0
    !insertmacro AL_LBL $alRunHead $alDlg 64 30 620 20 ${AL_SS_ONE} $alF13b "${AL_TEXT}" "${AL_FIELD}" "${HEAD}"
    !insertmacro AL_LBL $alRunL1 $alDlg 64 54 620 18 ${AL_SS_ONE} $alF12 "${AL_TEXT2}" "${AL_FIELD}" "栖枝关闭窗口后会留在托盘里继续运行，这次检测到："
    !insertmacro AL_LBL $alRunProc $alDlg 64 74 620 $7 ${AL_SS_ONE} $alFm "${AL_TEXT}" "${AL_FIELD}" "$6"
    !insertmacro AL_LBL $alRunBody $alDlg 64 $9 620 $8 ${AL_SS_ONE} $alF12 "${AL_TEXT2}" "${AL_FIELD}" "$alRunBT"
    IntOp $5 $4 + 34
    !insertmacro AL_LBL $alRunHint $alDlg 24 $5 672 18 ${AL_SS_ONE} $alF12 "${AL_TEXT2}" "${AL_PAGE}" "也可以先自己把栖枝退出，再点「重新检查」。"
    IntOp $5 $5 + 28
    !insertmacro AL_NSD $alRunBtn 24 $5 96 24 ${AL_WS_BTN} $alF12 "" "" "重新检查"
    ; the same dark button as the ones in the footer, painted on the page colour
    System::Call 'uxtheme::SetWindowTheme(p $alRunBtn, w "DarkMode_Explorer", p 0)'
    SetCtlColors $alRunBtn "${AL_TEXT}" "${AL_PAGE}"
    ${NSD_OnClick} $alRunBtn ${AL_P}alRunRecheck
    IntOp $5 $5 + 36
    !insertmacro AL_LBL $alRunMsg $alDlg 24 $5 672 36 ${AL_SS_TXT} $alF12 "${AL_GOLD}" "${AL_PAGE}" ""
    ShowWindow $alRunMsg ${SW_HIDE}
    !insertmacro AL_CRED $alDlg 24 346 "${AL_PAGE}" "${AL_C_FACE}"
    !insertmacro AL_BAR "返回" "${BTN}" 112 "取消"
    nsDialogs::Show
  FunctionEnd

  ; the "re-check" button
  Function ${AL_P}alRunRecheck
    Pop $0
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $1
    ${If} $1 != 0
      ; gone: the page says so everywhere (header, block) and closes up: no icon, no process line, no hint, no
      ; button, the block shrinks to two lines; the focus goes to the primary button
      !insertmacro MUI_HEADER_TEXT "栖枝已退出" "可以继续${AL_RUNOK}。"
      SendMessage $alRunHead ${WM_SETTEXT} 0 "STR:栖枝已经退出。"
      SendMessage $alRunBody ${WM_SETTEXT} 0 "STR:没有检测到栖枝在运行。点「${AL_RUNOK}」继续。"
      ShowWindow $alRunIcon ${SW_HIDE}
      ShowWindow $alRunL1 ${SW_HIDE}
      ShowWindow $alRunProc ${SW_HIDE}
      ShowWindow $alRunHint ${SW_HIDE}
      ShowWindow $alRunBtn ${SW_HIDE}
      ShowWindow $alRunMsg ${SW_HIDE}
      !insertmacro AL_POS $alRunHead 40 30 640 20
      !insertmacro AL_POS $alRunBody 40 54 640 18
      !insertmacro AL_POS $alRunBlk 24 20 672 66
      !insertmacro AL_POS $alRunBar 24 20 3 66
      SetCtlColors $alRunBar "${AL_HER_BAR}" "${AL_HER_BAR}"
      !insertmacro AL_BAR "返回" "${AL_RUNOK}" 96 "取消"
      System::Call 'user32::RedrawWindow(p $alDlg, p 0, p 0, i 0x181)' ; RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW
      SendMessage $HWNDPARENT 0x0028 $mui.Button.Next 1 ; WM_NEXTDLGCTL: the primary button takes the focus
      Return
    ${Else}
      SetCtlColors $alRunMsg "${AL_GOLD}" "${AL_PAGE}"
      SendMessage $alRunMsg ${WM_SETTEXT} 0 "STR:仍然检测到栖枝在运行。"
    ${EndIf}
    ShowWindow $alRunMsg ${SW_HIDE}
    ShowWindow $alRunMsg ${SW_SHOW}
  FunctionEnd

  ; the primary button: ask the app to close, then end it. Not through before-quit: the database is not
  ; checkpointed, running tasks stop, and the page says so.
  Function ${AL_P}alRunLeave
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $0
    ${If} $0 == 0
      nsProcess::_CloseProcess "${APP_EXECUTABLE_FILENAME}"
      Pop $0
      Sleep 1000
      StrCpy $1 0
      ${Do}
        nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
        Pop $0
        ${If} $0 != 0
          ${ExitDo}
        ${EndIf}
        ${If} $1 >= 3
          ${ExitDo}
        ${EndIf}
        nsProcess::_KillProcess "${APP_EXECUTABLE_FILENAME}"
        Pop $0
        Sleep 700
        IntOp $1 $1 + 1
      ${Loop}
      nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
      Pop $0
      ${If} $0 == 0
        SetCtlColors $alRunMsg "${AL_GOLD}" "${AL_PAGE}"
        SendMessage $alRunMsg ${WM_SETTEXT} 0 "STR:抱歉，没能关闭它，可能是以管理员身份运行的。请自己退出栖枝后点「重新检查」。"
        ShowWindow $alRunMsg ${SW_HIDE}
        ShowWindow $alRunMsg ${SW_SHOW}
        Abort
      ${EndIf}
    ${EndIf}
  FunctionEnd
!macroend

; ---------------------------------------------------------------------------------------------------
; installer pass
; ---------------------------------------------------------------------------------------------------
!macro AL_INSTALLER
  Var alPrevVer

  !define AL_RUNOK "安装"
  !insertmacro AL_RUNPAGE "栖枝正在运行" "安装前需要先关闭它。" "抱歉，栖枝还在运行，需要先关闭才能继续。" "点「关闭并安装」，安装程序会直接结束栖枝，不走正常退出流程：正在进行的任务会中断，不会自动续跑，最后几条还没写入的内容可能丢失。Agent 启动的命令行工具可能仍在后台，需要时请在任务管理器里结束。也会关闭正在运行的便携版。" "关闭并安装"

  ; I1 welcome (full window, plate on the left)
  Function alWelcomeShow
    ShowWindow $mui.Branding.Text ${SW_SHOW}
    !insertmacro AL_POS $mui.WelcomePage.Image 0 0 720 432
    !insertmacro AL_BOTTOM $mui.WelcomePage.Image
    !insertmacro AL_IMG $mui.WelcomePage.Image welcome.bmp
    !insertmacro AL_POS $mui.WelcomePage.Title 36 196 280 28
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $alF20b 0
    SetCtlColors $mui.WelcomePage.Title "${AL_TITLE}" "${AL_BG}"
    !insertmacro AL_POS $mui.WelcomePage.Text 36 232 296 64
    SendMessage $mui.WelcomePage.Text ${WM_SETFONT} $alF12 0
    SetCtlColors $mui.WelcomePage.Text "${AL_TEXT2}" "${AL_BG}"
    !insertmacro AL_HER $mui.WelcomePage 36 306 290 40 "${AL_BG}" "初次见面……我是遐蝶。这里的事，我隔着一根枝来做。"
    !insertmacro AL_CRED $mui.WelcomePage 36 384 "${AL_BG}" "${AL_C_FIG}"
    !insertmacro AL_CRED $mui.WelcomePage 36 398 "${AL_BG}" "${AL_C_AI}"
    !insertmacro AL_BAR "" "下一步" 96 "取消"
  FunctionEnd

  ; I2 licence: the text on the paper, three lines of plain facts under it
  Function alLicenseShow
    ; the inner dialog of a built-in page keeps its template size (825 x 420 px at 150%) unless it is set
    !insertmacro AL_POS $mui.LicensePage 0 64 720 368
    SetCtlColors $mui.LicensePage "${AL_TEXT}" "${AL_PAGE}"
    ShowWindow $mui.LicensePage.TopText ${SW_HIDE}
    ; the paper is a plain fill; the text box sits on it, inset by 12 DIP, without the sunken frame of the
    ; template (WS_BORDER, WS_EX_CLIENTEDGE and WS_EX_STATICEDGE taken off, then the frame is recalculated)
    !insertmacro AL_LBL $0 $mui.LicensePage 24 12 672 248 ${AL_SS_FILL} "" "${AL_PAPER}" "${AL_PAPER}" ""
    ; The text is for reading only: no tab stop (WS_TABSTOP 0x10000 off too), so Tab never lands in it and NSIS has no
    ; text box to give the focus (a read-only rich edit still shows a blinking caret once it has it).
    System::Call 'user32::GetWindowLongW(p $mui.LicensePage.LicenseText, i -16) i.R6' ; GWL_STYLE
    IntOp $R6 $R6 | 0x810000
    IntOp $R6 $R6 ^ 0x810000
    System::Call 'user32::SetWindowLongW(p $mui.LicensePage.LicenseText, i -16, i R6)'
    System::Call 'user32::GetWindowLongW(p $mui.LicensePage.LicenseText, i -20) i.R6' ; GWL_EXSTYLE
    IntOp $R6 $R6 | 0x20200
    IntOp $R6 $R6 ^ 0x20200
    System::Call 'user32::SetWindowLongW(p $mui.LicensePage.LicenseText, i -20, i R6)'
    System::Call 'user32::SetWindowPos(p $mui.LicensePage.LicenseText, p 0, i 0, i 0, i 0, i 0, i 0x37)' ; NOMOVE | NOSIZE | NOZORDER | NOACTIVATE | FRAMECHANGED
    !insertmacro AL_POS $mui.LicensePage.LicenseText 36 24 648 224
    System::Call 'user32::SetWindowPos(p $mui.LicensePage.LicenseText, p 0, i 0, i 0, i 0, i 0, i 0x13)' ; HWND_TOP, above the paper
    SendMessage $mui.LicensePage.LicenseText 0x0443 0 ${AL_PAPER_REF} ; EM_SETBKGNDCOLOR
    ; CHARFORMATW { cbSize 92, dwMask CFM_COLOR, ..., crTextColor, ... } applied with SCF_ALL
    System::Call '*(i 92, i 0x40000000, i 0, i 0, i 0, i ${AL_INK_REF}, &i2 0, &w32 "", &i2 0) p.r2'
    SendMessage $mui.LicensePage.LicenseText 0x0444 4 $2 ; EM_SETCHARFORMAT
    System::Free $2
    System::Call 'uxtheme::SetWindowTheme(p $mui.LicensePage.LicenseText, w "Explorer", p 0)'
    !insertmacro AL_POS $mui.LicensePage.Text 24 272 672 56
    SendMessage $mui.LicensePage.Text ${WM_SETFONT} $alF12 0
    SetCtlColors $mui.LicensePage.Text "${AL_TEXT2}" "${AL_PAGE}"
    !insertmacro AL_CRED $mui.LicensePage 24 346 "${AL_PAGE}" "${AL_C_FACE}"
    !insertmacro AL_BAR "返回" "我同意" 96 "取消"
    ; The focus goes to the primary button (posted, so it is handled once NSIS has done its own focusing after this
    ; function returns), and the text box has no caret to show.
    System::Call 'user32::HideCaret(p $mui.LicensePage.LicenseText)'
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i 0x0028, p $mui.Button.Next, p 1)'
  FunctionEnd

  ; I3 location: the MUI directory page, restyled, plus four plain facts
  Function alDirShow
    !insertmacro AL_POS $mui.DirectoryPage 0 64 720 368
    SetCtlColors $mui.DirectoryPage "${AL_TEXT}" "${AL_PAGE}"
    !insertmacro AL_BMP $0 $mui.DirectoryPage twig.bmp 16 6 60 190 1
    ShowWindow $mui.DirectoryPage.DirectoryBox ${SW_HIDE}
    !insertmacro AL_POS $mui.DirectoryPage.Text 84 8 612 34
    SendMessage $mui.DirectoryPage.Text ${WM_SETFONT} $alF12 0
    SetCtlColors $mui.DirectoryPage.Text "${AL_TEXT2}" "${AL_PAGE}"
    !insertmacro AL_POS $mui.DirectoryPage.Directory 84 48 512 24
    SendMessage $mui.DirectoryPage.Directory ${WM_SETFONT} $alFm 0
    SetCtlColors $mui.DirectoryPage.Directory "${AL_TEXT}" "${AL_FIELD}"
    System::Call 'uxtheme::SetWindowTheme(p $mui.DirectoryPage.Directory, w "DarkMode_CFD", p 0)'
    !insertmacro AL_POS $mui.DirectoryPage.BrowseButton 604 46 92 28
    SendMessage $mui.DirectoryPage.BrowseButton ${WM_SETFONT} $alF12 0
    SendMessage $mui.DirectoryPage.BrowseButton ${WM_SETTEXT} 0 "STR:浏览"
    System::Call 'uxtheme::SetWindowTheme(p $mui.DirectoryPage.BrowseButton, w "DarkMode_Explorer", p 0)'
    SetCtlColors $mui.DirectoryPage.BrowseButton "${AL_TEXT}" "${AL_PAGE}"
    ; the two native space labels (NSIS keeps them current when the folder changes) share one row
    !insertmacro AL_POS $mui.DirectoryPage.SpaceRequired 84 86 300 18
    SendMessage $mui.DirectoryPage.SpaceRequired ${WM_SETFONT} $alF12 0
    SetCtlColors $mui.DirectoryPage.SpaceRequired "${AL_TEXT2}" "${AL_PAGE}"
    !insertmacro AL_POS $mui.DirectoryPage.SpaceAvailable 390 86 306 18
    SendMessage $mui.DirectoryPage.SpaceAvailable ${WM_SETFONT} $alF12 0
    SetCtlColors $mui.DirectoryPage.SpaceAvailable "${AL_TEXT2}" "${AL_PAGE}"
    !insertmacro AL_LBL $0 $mui.DirectoryPage 84 108 612 18 ${AL_SS_ONE} $alF12 "${AL_TEXT2}" "${AL_PAGE}" "仅当前用户，不需要管理员权限。"
    !insertmacro AL_LBL $0 $mui.DirectoryPage 84 130 612 18 ${AL_SS_ONE} $alF12 "${AL_TEXT2}" "${AL_PAGE}" "对话与设置不在这个文件夹里，保存在下面的位置；卸载程序默认不会动它。"
    !insertmacro AL_PATHBOX $mui.DirectoryPage 84 150 612 "${AL_TEXT}" "${AL_PAGE}" "$alDataRoot"
    IntOp $3 $alH + 160
    ; data left behind by an earlier install: said only when it is there
    ${If} ${FileExists} "$alDataRoot\alight.db"
      StrCpy $alAccKB 0
      StrCpy $alAccR 0
      StrCpy $alAccN 0
      StrCpy $alAccE 0
      StrCpy $alA $alDataRoot
      Call alAddKB
      ${If} $alAccE == 1
        StrCpy $alA $alAccKB
        StrCpy $alB $alAccR
        Call alFmtSize
      ${Else}
        StrCpy $alR "大小未知"
      ${EndIf}
      IntOp $4 $3 + 9
      !insertmacro AL_LBL $0 $mui.DirectoryPage 84 $3 612 34 ${AL_SS_FILL} "" "${AL_FIELD}" "${AL_FIELD}" ""
      !insertmacro AL_LBL $0 $mui.DirectoryPage 84 $3 3 34 ${AL_SS_FILL} "" "${AL_HER_BAR}" "${AL_HER_BAR}" ""
      !insertmacro AL_LBL $0 $mui.DirectoryPage 100 $4 580 18 ${AL_SS_ONE} $alF12 "${AL_TEXT}" "${AL_FIELD}" "找到上次留存的数据，共 $alR，安装后自动接上。"
    ${EndIf}
    !insertmacro AL_CRED $mui.DirectoryPage 24 346 "${AL_PAGE}" "${AL_C_FACE}"
    !insertmacro AL_BAR "返回" "安装" 96 "取消"
    ; the path box opens with the caret at the start (the drive letter shows), nothing selected. NSIS gives the
    ; box the focus, and selects all of it, after this function returns, so the correction is posted: it is
    ; handled after that, when the message loop runs again.
    SendMessage $mui.DirectoryPage.Directory 0x00B1 0 0 ; EM_SETSEL 0, 0
    System::Call 'user32::PostMessageW(p $mui.DirectoryPage.Directory, i 0x00B1, p 0, p 0)'
    System::Call 'user32::PostMessageW(p $mui.DirectoryPage.Directory, i 0x00B7, p 0, p 0)' ; EM_SCROLLCARET
  FunctionEnd

  ; I5 installing: a band picture, the plain status line, the native progress bar
  Function alInstShow
    !insertmacro AL_POS $mui.InstFilesPage 0 64 720 368
    SetCtlColors $mui.InstFilesPage "${AL_TEXT}" "${AL_PAGE}"
    !insertmacro AL_BMP $0 $mui.InstFilesPage band.bmp 0 0 720 160 1
    ShowWindow $mui.InstFilesPage.ShowLogButton ${SW_HIDE}
    ShowWindow $mui.InstFilesPage.Log ${SW_HIDE}
    !insertmacro AL_POS $mui.InstFilesPage.Text 40 182 640 20
    SendMessage $mui.InstFilesPage.Text ${WM_SETFONT} $alF12 0
    SetCtlColors $mui.InstFilesPage.Text "${AL_TEXT}" "${AL_PAGE}"
    SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:正在解开程序文件"
    !insertmacro AL_POS $mui.InstFilesPage.ProgressBar 40 214 640 8
    System::Call 'uxtheme::SetWindowTheme(p $mui.InstFilesPage.ProgressBar, w " ", w " ")'
    SendMessage $mui.InstFilesPage.ProgressBar 0x0409 0 ${AL_BLUE_REF}  ; PBM_SETBARCOLOR
    SendMessage $mui.InstFilesPage.ProgressBar 0x2001 0 ${AL_FIELD_REF} ; PBM_SETBKCOLOR
    !insertmacro AL_LBL $0 $mui.InstFilesPage 40 240 640 16 ${AL_SS_ONE} $alF11 "${AL_TEXT3}" "${AL_PAGE}" "安装位置"
    !insertmacro AL_PATHBOX $mui.InstFilesPage 40 258 640 "${AL_TEXT2}" "${AL_PAGE}" "$INSTDIR"
    !insertmacro AL_CRED $mui.InstFilesPage 24 318 "${AL_PAGE}" "${AL_C_AI}"
    !insertmacro AL_CRED $mui.InstFilesPage 24 332 "${AL_PAGE}" "${AL_C_FACE}"
    !insertmacro AL_BAR "返回" "下一步" 96 "取消"
    ; nothing to press while the files are written (AL_BAR shows Next again on the next page)
    ShowWindow $mui.Button.Back ${SW_HIDE}
    ShowWindow $mui.Button.Next ${SW_HIDE}
  FunctionEnd

  ; The "run" box of the finish page (when there is one): a click redraws its glyph
  !ifdef AL_SHOW_RUN
  Function alRunChk
    Pop $0
    StrCpy $alA $0
    Call alChkSync
  FunctionEnd
  !endif

  ; The receipt rows of the finish page, flowed from the running y in $3 (AL_RTXT / AL_RPATH). Needs $1 (size
  ; text), $2 (shortcuts) and $4 (the version line of an update). With $alDry = 1 it only measures.
  Function alFinRows
    ${If} ${isUpdated}
      !insertmacro AL_RTXT $mui.FinishPage 38 100 204 "版本" "$4"
      !insertmacro AL_RTXT $mui.FinishPage 38 100 204 "程序文件" "已替换，$1"
      !insertmacro AL_RTXT $mui.FinishPage 38 100 204 "数据" "对话、设置与密钥原样保留"
      !insertmacro AL_RPATH $mui.FinishPage 38 100 204 "位置" "$INSTDIR"
    ${Else}
      !insertmacro AL_RTXT $mui.FinishPage 38 100 204 "已安装" "栖枝 ${VERSION}"
      !insertmacro AL_RPATH $mui.FinishPage 38 100 204 "位置" "$INSTDIR"
      !insertmacro AL_RTXT $mui.FinishPage 38 100 204 "大小" "$1"
      !insertmacro AL_RTXT $mui.FinishPage 38 100 204 "快捷方式" "$2"
      !insertmacro AL_RPATH $mui.FinishPage 38 100 204 "数据位置" "$alDataRoot"
      !insertmacro AL_TUCK
      !insertmacro AL_RTXT $mui.FinishPage 38 100 204 "" "卸载默认不动"
    ${EndIf}
  FunctionEnd

  ; I6 finish (full window, official splash): a receipt on the paper, one line from her. A flowed layout: the
  ; credit line (y 412) and the "run" box (y 386) are anchored at the bottom with their room reserved; the paper
  ; and her line run down from the title and may reach only as far as that room allows. If the rows do not fit
  ; (long paths), the layout is tried again with a smaller path font and gaps, then with every path shortened
  ; to one line in the middle (and a button that copies the full ones). The paper stays inside x 24..312: the
  ; splash starts at 320 and is never covered.
  Function alFinishShow
    ShowWindow $mui.Branding.Text ${SW_SHOW}
    !insertmacro AL_POS $mui.FinishPage.Image 0 0 720 432
    !insertmacro AL_BOTTOM $mui.FinishPage.Image
    !insertmacro AL_IMG $mui.FinishPage.Image finish.bmp
    ShowWindow $mui.FinishPage.Text ${SW_HIDE}
    !insertmacro AL_POS $mui.FinishPage.Title 28 128 288 28
    SendMessage $mui.FinishPage.Title ${WM_SETFONT} $alF20b 0
    SetCtlColors $mui.FinishPage.Title "${AL_TITLE}" "${AL_BG}"

    ; facts, measured now (real bytes)
    StrCpy $alAccKB 0
    StrCpy $alAccR 0
    StrCpy $alAccN 0
    StrCpy $alAccE 0
    StrCpy $alA $INSTDIR
    Call alAddKB
    ${If} $alAccE == 1
      StrCpy $alA $alAccKB
      StrCpy $alB $alAccR
      Call alFmtSize
      StrCpy $1 "$alAccN 个文件，$alR"
    ${Else}
      StrCpy $1 "大小未知"
    ${EndIf}
    ${If} ${isNoDesktopShortcut}
      StrCpy $2 "开始菜单"
    ${Else}
      StrCpy $2 "桌面、开始菜单"
    ${EndIf}
    StrCpy $4 ""
    ${If} ${isUpdated}
      SendMessage $mui.FinishPage.Title ${WM_SETTEXT} 0 "STR:更新完成"
      ${If} $alPrevVer == ""
        StrCpy $4 "栖枝 ${VERSION}"
        StrCpy $5 "旧的这一版，我送走了。"
      ${ElseIf} $alPrevVer == "${VERSION}"
        ; the same version again: nothing was sent away, so she says nothing
        StrCpy $4 "重新安装 ${VERSION}"
        StrCpy $5 ""
      ${Else}
        StrCpy $4 "$alPrevVer → ${VERSION}"
        StrCpy $5 "旧的这一版，我送走了。"
      ${EndIf}
    ${Else}
      StrCpy $5 "装好了。愿它被好好用上。"
    ${EndIf}

    ; her line: its box height ($alH), and with the 10 DIP above it the room it takes under the paper ($6)
    StrCpy $6 0
    StrCpy $8 0
    ${If} $5 != ""
      StrCpy $alA $5
      StrCpy $alB $alF13
      StrCpy $alC 278
      Call alTextH
      IntOp $8 $alR + 4
      IntOp $6 $8 + 10
    ${EndIf}
    IntOp $7 382 - $6 ; the lowest edge the paper may have (the "run" box starts at 386)

    ; the tier loop: dry runs from the normal layout to the tightest, the first that fits is kept
    StrCpy $alTier 0
    ${Do}
      StrCpy $alA $alTier
      Call alSetMode
      StrCpy $alDry 1
      StrCpy $3 176
      Call alFinRows
      IntOp $R0 $3 - $alGap
      IntOp $R0 $R0 + 6 ; the paper's bottom edge
      ${If} $R0 <= $7
      ${OrIf} $alTier >= 2
        ${ExitDo}
      ${EndIf}
      IntOp $alTier $alTier + 1
    ${Loop}
    StrCpy $alDry 0

    ; the paper is made first (so the rows land above it), at the height the rows asked for
    IntOp $alH $R0 - 164
    !insertmacro AL_LBL $alPaper $mui.FinishPage 24 164 288 $alH ${AL_SS_FILL} "" "${AL_PAPER}" "${AL_PAPER}" ""
    StrCpy $3 176
    Call alFinRows
    ${If} $5 != ""
      IntOp $3 $R0 + 10
      !insertmacro AL_HER $mui.FinishPage 28 $3 288 $8 "${AL_BG}" "$5"
    ${EndIf}
    !ifdef AL_SHOW_RUN
      !insertmacro AL_CHKDRESS $mui.FinishPage.Run $mui.FinishPage 28 386 288 20 "${AL_TEXT}" "${AL_BG}" "运行栖枝" alRunChk
    !endif
    !insertmacro AL_CRED $mui.FinishPage 28 412 "${AL_BG}" "${AL_C_FIG}"
    !insertmacro AL_BAR "" "完成" 96 ""
    StrCpy $alA 0
    Call alSetMode
  FunctionEnd
!macroend

; ---------------------------------------------------------------------------------------------------
; uninstaller pass
; ---------------------------------------------------------------------------------------------------

; set one inventory row of the files page. STATE: a = waiting, b = in progress, c = done. Each row has
; three stacked statics (one colour each), only one of them visible, so nothing but text and visibility
; changes while the uninstall section runs on its own thread.
!macro AL_INV ROW STATE TEXT
  ShowWindow $alIv${ROW}a ${SW_HIDE}
  ShowWindow $alIv${ROW}b ${SW_HIDE}
  ShowWindow $alIv${ROW}c ${SW_HIDE}
  SendMessage $alIv${ROW}${STATE} ${WM_SETTEXT} 0 "STR:${TEXT}"
  ShowWindow $alIv${ROW}${STATE} ${SW_SHOW}
!macroend

!macro AL_INVROW N Y LABEL
  !insertmacro AL_LBL $0 $mui.InstFilesPage 40 ${Y} 64 18 ${AL_SS_ONE} $alF12 "${AL_TEXT3}" "${AL_PAGE}" "${LABEL}"
  !insertmacro AL_LBL $alIv${N}a $mui.InstFilesPage 112 ${Y} 568 18 ${AL_SS_ONE} $alF12 "${AL_TEXT3}" "${AL_PAGE}" "待处理"
  !insertmacro AL_LBL $alIv${N}b $mui.InstFilesPage 112 ${Y} 568 18 ${AL_SS_ONE} $alF12 "${AL_BLUE}" "${AL_PAGE}" ""
  ShowWindow $alIv${N}b ${SW_HIDE}
  !insertmacro AL_LBL $alIv${N}c $mui.InstFilesPage 112 ${Y} 568 18 ${AL_SS_ONE} $alF12 "${AL_TEXT}" "${AL_PAGE}" ""
  ShowWindow $alIv${N}c ${SW_HIDE}
!macroend

; $1 = 0 when $alA contains NEEDLE (path sanity)
!macro AL_BAD NEEDLE
  StrCpy $alA $2
  StrCpy $alB '${NEEDLE}'
  Call un.alIndexOf
  ${If} $alR <> -1
    StrCpy $1 0
  ${EndIf}
!macroend

; delete one file by name and check it is gone; a file that stays goes on the failure list
!macro AL_DELFILE PATH
  ${If} ${FileExists} "${PATH}"
    Delete "${PATH}"
    ${If} ${FileExists} "${PATH}"
      StrCpy $alA "${PATH}"
      Call un.alFailAdd
    ${EndIf}
  ${EndIf}
!macroend

; one group of the delete-confirmation table: shown only if at least one member is there
!macro AL_GROUP POS CONTENT P1 P2 P3 P4
  StrCpy $alAccKB 0
  StrCpy $alAccR 0
  StrCpy $alAccN 0
  StrCpy $alAccE 0
  !if "${P1}" != ""
    StrCpy $alA "$alDataRoot\${P1}"
    Call un.alAddKB
  !endif
  !if "${P2}" != ""
    StrCpy $alA "$alDataRoot\${P2}"
    Call un.alAddKB
  !endif
  !if "${P3}" != ""
    StrCpy $alA "$alDataRoot\${P3}"
    Call un.alAddKB
  !endif
  !if "${P4}" != ""
    StrCpy $alA "$alDataRoot\${P4}"
    Call un.alAddKB
  !endif
  ${If} $alAccE == 1
    IntOp $alSumKB $alSumKB + $alAccKB
    IntOp $alSumR $alSumR + $alAccR
    ${If} $alSumR >= 1024
      IntOp $alSumR $alSumR - 1024
      IntOp $alSumKB $alSumKB + 1
    ${EndIf}
    IntOp $alSumN $alSumN + $alAccN
    IntOp $alRows $alRows + 1
    StrCpy $alA $alAccKB
    StrCpy $alB $alAccR
    Call un.alFmtSize
    StrCpy $0 "${POS}$\r$\n"
    StrCpy $alT1 "$alT1$0"
    StrCpy $0 "${CONTENT}$\r$\n"
    StrCpy $alT2 "$alT2$0"
    StrCpy $0 "$alR$\r$\n"
    StrCpy $alT3 "$alT3$0"
  ${EndIf}
!macroend

; one entry of the deny list of un.alSafeDD: $2 is the candidate; it fails ($1 = 0) when it is PATH or a folder above PATH
!macro AL_DENY PATH
  StrCpy $3 "${PATH}\"
  StrLen $0 "$2\"
  StrCpy $3 $3 $0
  ${If} $3 == "$2\"
    StrCpy $1 0
  ${EndIf}
!macroend

; one row of the paper list on the data-choice page: $1 label, $2 path, $4 text (each may be empty), laid out
; from the running y in $3, which moves on by the row's height plus the gap. The path takes as many monospace
; lines as it needs (tier 2 and up: one line with its middle left out, and a copy button of its own); the text takes
; the whole column and is broken between words (alTextH), so nothing is cut off, nothing overlaps and no line is a
; lone character. With $alDry = 1 it only measures.
!macro AL_SLOT N
  ${If} $alDry <> 1
    ${If} $1 != ""
      SendMessage $alChL${N} ${WM_SETTEXT} 0 "STR:$1"
      IntOp $8 $3 + 1
      !insertmacro AL_POS $alChL${N} 272 $8 40 16
      ShowWindow $alChL${N} ${SW_SHOW}
    ${Else}
      ShowWindow $alChL${N} ${SW_HIDE}
    ${EndIf}
    ShowWindow $alChC${N} ${SW_HIDE}
  ${EndIf}
  StrCpy $6 0
  ${If} $2 != ""
    StrCpy $alA $2
    ${If} $alMode >= 2
      StrCpy $alC 324
    ${Else}
      StrCpy $alC 370
    ${EndIf}
    Call un.alPathWrap
    IntOp $6 $alN * $alLH
    ${If} $alMode >= 2
    ${AndIf} $6 < 18
      StrCpy $6 18
    ${EndIf}
    ${If} $alDry <> 1
      SendMessage $alChP${N} ${WM_SETTEXT} 0 "STR:$alR"
      ${If} $alMode = 0
        SendMessage $alChP${N} ${WM_SETFONT} $alFm 0
      ${Else}
        SendMessage $alChP${N} ${WM_SETFONT} $alFm10 0
      ${EndIf}
      IntOp $7 $alN * $alLH
      ${If} $alMode >= 2
        IntOp $8 $6 - $7
        IntOp $8 $8 / 2
        IntOp $8 $8 + $3
        !insertmacro AL_POS $alChP${N} 316 $8 324 $7
        !insertmacro AL_POS $alChC${N} 642 $3 44 18
        StrCpy $alA $alChC${N}
        StrCpy $alB $2
        Call un.alCopyTag
        SendMessage $alChC${N} ${WM_SETTEXT} 0 "STR:复制"
        ShowWindow $alChC${N} ${SW_SHOW}
      ${Else}
        !insertmacro AL_POS $alChP${N} 316 $3 370 $7
      ${EndIf}
      ShowWindow $alChP${N} ${SW_SHOW}
    ${EndIf}
  ${ElseIf} $alDry <> 1
    ShowWindow $alChP${N} ${SW_HIDE}
  ${EndIf}
  StrCpy $7 0
  ${If} $4 != ""
    StrCpy $alA $4
    StrCpy $alB $alF11
    StrCpy $alC 370
    Call un.alTextH
    StrCpy $7 $alR
    ${If} $alDry <> 1
      IntOp $8 $3 + $6
      SendMessage $alChV${N} ${WM_SETTEXT} 0 "STR:$alWT"
      !insertmacro AL_POS $alChV${N} 316 $8 370 $7
      ShowWindow $alChV${N} ${SW_SHOW}
    ${EndIf}
  ${ElseIf} $alDry <> 1
    ShowWindow $alChV${N} ${SW_HIDE}
  ${EndIf}
  IntOp $8 $6 + $7
  ${If} $8 > 0
    IntOp $3 $3 + $8
    IntOp $3 $3 + $alGap
    ${If} $alMode = 0
      IntOp $3 $3 + 2
    ${EndIf}
  ${EndIf}
!macroend

; ---------------------------------------------------------------------------------------------------
; uninstaller pass
; ---------------------------------------------------------------------------------------------------
!macro AL_UNINSTALLER
  Var alDrop      ; 1 = delete the data (only ever set by the choice page); empty = keep
  Var alDD        ; a custom data folder (ALIGHT_DATA_DIR or store-config.json dataDir), when recognised
  Var alDDHint    ; 1 = the data folder was moved but could not be read
  Var alDDDone
  Var alDelDD     ; 1 = the user ticked "also delete the files in the custom data folder"
  Var alDataSize  ; "9.7 MB" / "大小未知"
  Var alDataFiles ; file count, "" when unknown
  Var alDataKB
  Var alDataR     ; the bytes beyond alDataKB (0..1023)
  Var alDataEx    ; 1 = the data root exists
  Var alFailCount
  Var alFailList
  Var alFailShown
  Var alSumKB
  Var alSumR
  Var alSumN
  Var alT1
  Var alT2
  Var alT3
  Var alRows      ; rows in the delete-confirmation table
  Var alFailCopy  ; the same paths, one per line, for the "copy path" button
  Var alShownN    ; how many of them the finish page listed
  Var alWalkHit   ; files found by alFailWalk under the folder it is working on
  Var alProgLeft  ; 1 = the program folder was still there after the uninstall
  Var alLeftText  ; what the uninstall left behind, as a sentence part ("" = nothing)
  Var alRdK
  Var alRdD
  Var alChImg
  Var alBmpK
  Var alBmpD
  Var alChBar
  Var alBdK       ; the hairline behind each choice card, recoloured when it is the chosen one
  Var alBdD
  Var alIndK      ; the ring / dot glyph on each card (the radio button's own glyph is covered)
  Var alIndD
  Var alChL1
  Var alChP1
  Var alChV1
  Var alChL2
  Var alChP2
  Var alChV2
  Var alChL3
  Var alChP3
  Var alChV3
  Var alChL4
  Var alChP4
  Var alChV4
  Var alChC1      ; the copy buttons of the path rows (shown from tier 2)
  Var alChC2
  Var alChC3
  Var alChC4
  Var alCopyLbl   ; its label
  Var alNote      ; a note that goes behind a path on the failure list (not into the copy)
  Var alDDSrc     ; where the custom data folder came from: "env" (ALIGHT_DATA_DIR) or "cfg" (store-config.json)
  Var alCacheState ; the auto-updater cache: "" not there / not touched, 1 removed, 2 something stayed
  Var alRmText    ; what the finish page says was removed (program files, shortcuts, maybe the update cache)
  Var alPick      ; 1 = the "drop" card is the chosen one
  Var alChHer
  Var alChHerBar
  Var alChkV
  Var alChkD
  Var alIv1a
  Var alIv1b
  Var alIv1c
  Var alIv2a
  Var alIv2b
  Var alIv2c
  Var alIv3a
  Var alIv3b
  Var alIv3c
  Var alIv4a
  Var alIv4b
  Var alIv4c

  !define AL_RUNOK "卸载"
  !insertmacro AL_RUNPAGE "栖枝正在运行" "卸载前需要先关闭它。" "抱歉，栖枝还在运行，需要先关闭才能继续卸载。" "点「关闭并卸载」，卸载程序会直接结束栖枝，不走正常退出流程：正在进行的任务会中断，最后几条还没写入的内容可能丢失。也会关闭正在运行的便携版。" "关闭并卸载"

  ; the data folder, measured once: size and file count
  Function un.alScanData
    ${If} $alDataSize != ""
      Return
    ${EndIf}
    StrCpy $alAccKB 0
    StrCpy $alAccR 0
    StrCpy $alAccN 0
    StrCpy $alAccE 0
    StrCpy $alA $alDataRoot
    Call un.alAddKB
    StrCpy $alDataEx $alAccE
    ${If} $alDataEx == 1
      StrCpy $alDataKB $alAccKB
      StrCpy $alDataR $alAccR
      StrCpy $alDataFiles $alAccN
      StrCpy $alA $alAccKB
      StrCpy $alB $alAccR
      Call un.alFmtSize
      StrCpy $alDataSize $alR
    ${Else}
      StrCpy $alDataKB 0
      StrCpy $alDataR 0
      StrCpy $alDataFiles ""
      StrCpy $alDataSize "大小未知"
    ${EndIf}
  FunctionEnd

  ; $alA = a path or a name -> $alR "ok" when it has none of: quote, percent (cmd expands it even inside
  ; quotes), caret, ".."
  Function un.alCharsOK
    Push $1
    Push $2
    StrCpy $2 $alA
    StrCpy $1 1
    !insertmacro AL_BAD '"'
    !insertmacro AL_BAD '%'
    !insertmacro AL_BAD '^'
    !insertmacro AL_BAD '..'
    ${If} $1 = 1
      StrCpy $alR "ok"
    ${Else}
      StrCpy $alR "no"
    ${EndIf}
    Pop $2
    Pop $1
  FunctionEnd

  ; $alA = an absolute path -> $alR "ok" when it may be touched at all: X:\something, not a drive root,
  ; no quote / percent / caret / "..", not a link. The test build also needs it under the sandbox.
  Function un.alSafePath
    Push $0
    Push $1
    Push $2
    Push $3
    StrCpy $2 $alA
    StrCpy $1 0
    StrLen $0 $2
    ${If} $0 >= 4
      StrCpy $3 $2 1 1
      ${If} $3 == ":"
        StrCpy $3 $2 1 2
        ${If} $3 == "\"
          StrCpy $1 1
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $1 = 1
      StrCpy $alA $2
      Call un.alCharsOK
      ${If} $alR != "ok"
        StrCpy $1 0
      ${EndIf}
    ${EndIf}
    ${If} $1 = 1
      System::Call 'kernel32::GetFileAttributesW(w "$2") i.r0'
      ${If} $0 <> -1
        IntOp $0 $0 & 0x400
        ${If} $0 <> 0
          StrCpy $1 0 ; a link
        ${EndIf}
      ${EndIf}
    ${EndIf}
    !ifdef AL_TEST_BUILD
      ${If} $1 = 1
        StrLen $0 "${AL_SANDBOX_PREFIX}"
        StrCpy $3 $2 $0
        ${If} $3 != "${AL_SANDBOX_PREFIX}"
          StrCpy $1 0
        ${EndIf}
      ${EndIf}
    !endif
    ${If} $1 = 1
      StrCpy $alR "ok"
    ${Else}
      StrCpy $alR "no"
    ${EndIf}
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = a path as written by the user or a config file -> $alR the full, long-name form without a trailing
  ; backslash (so "C:\." is "C:\", "C:/x/y" is "C:\x\y", an 8.3 name is spelled out), or "" when Windows cannot say
  Function un.alNorm
    Push $0
    Push $1
    StrCpy $alR ""
    System::Call 'kernel32::GetFullPathNameW(w "$alA", i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r0'
    ${If} $0 > 0
    ${AndIf} $0 < ${NSIS_MAX_STRLEN}
      StrCpy $alR $1
      System::Call 'kernel32::GetLongPathNameW(w "$alR", w .r1, i ${NSIS_MAX_STRLEN}) i.r0'
      ${If} $0 > 0
      ${AndIf} $0 < ${NSIS_MAX_STRLEN}
        StrCpy $alR $1
      ${EndIf}
      StrLen $0 $alR
      ${If} $0 > 3
        StrCpy $1 $alR 1 -1
        ${If} $1 == "\"
          StrCpy $alR $alR -1
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Pop $1
    Pop $0
  FunctionEnd

  ; $alA = a normalised folder -> $alR "ok" when it may be offered as a custom data folder: a plain, safe path
  ; (see un.alSafePath), not a drive root, and neither the user's profile, AppData, the Windows folder, Program
  ; Files, the install folder, nor a folder above any of them or above the data root
  Function un.alSafeDD
    Push $0
    Push $1
    Push $2
    Push $3
    StrCpy $2 $alA
    StrCpy $1 1
    StrLen $0 $2
    ${If} $0 < 4
      StrCpy $1 0
    ${EndIf}
    StrCpy $3 $2 1 -1
    ${If} $3 == "."
    ${OrIf} $3 == " "
      StrCpy $1 0
    ${EndIf}
    ${If} $1 = 1
      StrCpy $alA $2
      Call un.alSafePath
      ${If} $alR != "ok"
        StrCpy $1 0
      ${EndIf}
    ${EndIf}
    ${If} $1 = 1
      !insertmacro AL_DENY $alDataRoot
      !insertmacro AL_DENY $PROFILE
      !insertmacro AL_DENY $APPDATA
      !insertmacro AL_DENY $LOCALAPPDATA
      !insertmacro AL_DENY $WINDIR
      !insertmacro AL_DENY $PROGRAMFILES
      !insertmacro AL_DENY $PROGRAMFILES64
      !insertmacro AL_DENY $INSTDIR
      !insertmacro AL_DENY $DESKTOP
      !insertmacro AL_DENY $DOCUMENTS
    ${EndIf}
    ${If} $1 = 1
      StrCpy $alR "ok"
    ${Else}
      StrCpy $alR "no"
    ${EndIf}
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; a custom data folder, if the user moved it: ALIGHT_DATA_DIR, else store-config.json dataDir (read with
  ; PowerShell: FileRead garbles UTF-8 Chinese paths). Sets $alDD (recognised, exists) or $alDDHint.
  Function un.alFindDD
    ${If} $alDDDone == 1
      Return
    ${EndIf}
    StrCpy $alDDDone 1
    StrCpy $alDD ""
    StrCpy $alDDHint ""
    StrCpy $alDDSrc ""
    ReadEnvStr $0 "ALIGHT_DATA_DIR"
    ${If} $0 == ""
      ReadRegStr $0 HKCU "Environment" "ALIGHT_DATA_DIR"
    ${EndIf}
    ; the app looks at the environment variable first and ignores store-config.json when it is set
    ${If} $0 != ""
      StrCpy $alDDSrc "env"
    ${EndIf}
    ${If} $0 == ""
      ${If} ${FileExists} "$alDataRoot\store-config.json"
        StrCpy $alA "try { $$j = Get-Content -Raw -Encoding UTF8 -LiteralPath '$alDataRoot\store-config.json' | ConvertFrom-Json; 'OK|' + [string]$$j.dataDir } catch { 'ERR' }"
        Call un.alPsOut
        StrCpy $1 $alR 3
        ${If} $1 == "OK|"
          StrCpy $0 $alR "" 3
          ${If} $0 != ""
            StrCpy $alDDSrc "cfg"
          ${EndIf}
        ${Else}
          ; unreadable: is the key in the file at all?
          ClearErrors
          FileOpen $1 "$alDataRoot\store-config.json" r
          ${IfNot} ${Errors}
            ${Do}
              ClearErrors
              FileRead $1 $2
              ${If} ${Errors}
                ${ExitDo}
              ${EndIf}
              StrCpy $alA $2
              StrCpy $alB "dataDir"
              Call un.alIndexOf
              ${If} $alR <> -1
                StrCpy $alDDHint 1
                ${ExitDo}
              ${EndIf}
            ${Loop}
            FileClose $1
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ${If} $0 != ""
      ; the same spelling for both: forward slashes, a trailing "\.", 8.3 names and the like are resolved first
      StrCpy $alA $0
      Call un.alNorm
      ${If} $alR == ""
        StrCpy $alDDHint 1
      ${Else}
        StrCpy $0 $alR
        StrCpy $alA $alDataRoot
        Call un.alNorm
        ${If} $alR == ""
          StrCpy $alR $alDataRoot
        ${EndIf}
        StrCpy $1 $alR
        ; inside the data root: it goes with the data root, there is nothing separate to offer
        StrLen $2 "$1\"
        StrCpy $3 "$0\" $2
        ${If} $0 == $1
        ${OrIf} $3 == "$1\"
          ; the default folder (or inside it): nothing to recognise
        ${Else}
          StrCpy $alA $0
          Call un.alSafeDD
          ${If} $alR == "ok"
            ${If} ${FileExists} "$0\*.*"
              StrCpy $alDD $0
            ${EndIf}
          ${Else}
            StrCpy $alDDHint 1
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  FunctionEnd

  ; $alA = a path that could not be deleted, $alNote = what to say about it behind the path ("" for none; cleared
  ; here). The first six (as long as they fit a NSIS string) are kept, raw and each ended by "|" (not a character a
  ; path can hold), for the finish page to lay out; $alFailCopy keeps the plain paths, one per line, for the copy
  ; button; all of them are counted.
  Function un.alFailAdd
    Push $0
    Push $1
    IntOp $alFailCount $alFailCount + 1
    ${If} $alFailShown < 6
      StrLen $0 $alFailList
      StrLen $1 $alA
      IntOp $0 $0 + $1
      StrLen $1 $alNote
      IntOp $0 $0 + $1
      ${If} $0 < 880
        StrCpy $alFailList "$alFailList$alA$alNote|"
        StrCpy $alFailCopy "$alFailCopy$alA$\r$\n"
        IntOp $alFailShown $alFailShown + 1
      ${EndIf}
    ${EndIf}
    StrCpy $alNote ""
    Pop $1
    Pop $0
  FunctionEnd

  ; Push <a folder that could not be removed>, Call: every file (or link) still inside it goes on the failure list
  ; one by one, so the finish page can name what really holds it. $alWalkHit counts them. Links are never
  ; followed. The long-path form is used for the search, the names listed are the plain ones.
  Function un.alFailWalk
    Exch $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $6
    System::Alloc 592 ; WIN32_FIND_DATAW
    Pop $1
    StrCpy $2 $0 2
    ${If} $2 == "\\"
      StrCpy $2 $0
    ${Else}
      StrCpy $2 "\\?\$0"
    ${EndIf}
    System::Call 'kernel32::FindFirstFileW(w "$2\*", p r1) i.r2'
    ${If} $2 <> -1
    ${AndIf} $2 <> 0
      ${Do}
        System::Call '*$1(i.r3, l, l, l, i, i, i, i, &w260.r6)' ; attributes, name
        ${If} $6 != "."
        ${AndIf} $6 != ".."
          IntOp $4 $3 & 0x400
          ${If} $4 = 0
            IntOp $4 $3 & 0x10
            ${If} $4 <> 0
              Push "$0\$6"
              Call un.alFailWalk
            ${Else}
              StrCpy $alA "$0\$6"
              Call un.alFailAdd
              IntOp $alWalkHit $alWalkHit + 1
            ${EndIf}
          ${Else}
            StrCpy $alA "$0\$6"
            Call un.alFailAdd
            IntOp $alWalkHit $alWalkHit + 1
          ${EndIf}
        ${EndIf}
        System::Call 'kernel32::FindNextFileW(i r2, p r1) i.r3'
        ${If} $3 = 0
          ${ExitDo}
        ${EndIf}
      ${Loop}
      System::Call 'kernel32::FindClose(i r2)'
    ${EndIf}
    System::Free $1
    Pop $6
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; U1 uninstall welcome: the left plate is 330 DIP wide, the text stays inside it
  Function un.alWelcomeShow
    StrCpy $alDrop ""
    ShowWindow $mui.Branding.Text ${SW_SHOW}
    !insertmacro AL_POS $mui.WelcomePage.Image 0 0 720 432
    !insertmacro AL_BOTTOM $mui.WelcomePage.Image
    !insertmacro AL_IMG $mui.WelcomePage.Image un_welcome.bmp
    !insertmacro AL_POS $mui.WelcomePage.Title 36 168 284 28
    SendMessage $mui.WelcomePage.Title ${WM_SETFONT} $alF20b 0
    SetCtlColors $mui.WelcomePage.Title "${AL_TITLE}" "${AL_BG}"
    !insertmacro AL_POS $mui.WelcomePage.Text 36 206 284 40
    SendMessage $mui.WelcomePage.Text ${WM_SETFONT} $alF12 0
    SetCtlColors $mui.WelcomePage.Text "${AL_TEXT2}" "${AL_BG}"
    !insertmacro AL_PATHBOX $mui.WelcomePage 36 250 284 "${AL_TEXT}" "${AL_BG}" "$INSTDIR"
    IntOp $3 $alH + 262
    !insertmacro AL_LBL $0 $mui.WelcomePage 36 $3 284 40 ${AL_SS_TXT} $alF12 "${AL_TEXT2}" "${AL_BG}" "下一页选择数据的去向，默认保留。"
    !insertmacro AL_CRED $mui.WelcomePage 36 382 "${AL_BG}" "${AL_C_FACE}"
    !insertmacro AL_CRED $mui.WelcomePage 36 396 "${AL_BG}" "${AL_C_AI}"
    !insertmacro AL_BAR "" "下一步" 96 "取消"
  FunctionEnd

  ; U2 where the data goes. Default and only way back: keep.
  ; The two cards are real radio buttons that cover the whole card with no text of their own (static texts above
  ; them let every click through), so a click anywhere on a card, or an arrow key, picks it. The radio button's
  ; own white glyph is covered by a ring / dot glyph in the skin's colours, and the chosen card's frame turns
  ; the accent colour. Z order is creation order: the radios are made lower one first, so that arrow keys
  ; move between the two and nothing else; the control under them starts a new group.
  Function un.alChoosePre
    ${If} ${Silent}
    ${OrIf} ${isUpdated}
      Abort
    ${EndIf}
    StrCpy $alDrop ""
    Call un.alScanData
    Call un.alFindDD
    !insertmacro MUI_HEADER_TEXT "数据的去向" "选择卸载后，对话、设置和密钥怎么处理。"
    nsDialogs::Create 1018
    Pop $alDlg
    ${If} $alDlg == error
      Abort
    ${EndIf}
    SetCtlColors $alDlg "${AL_TEXT}" "${AL_PAGE}"

    ; the crop picture: both frames are loaded, the keep frame is the one left in the control
    !insertmacro AL_CTL $alChImg $alDlg STATIC 24 12 216 280 ${AL_SS_BMP} "" "" "" ""
    !insertmacro AL_IMG $alChImg choose_drop.bmp
    StrCpy $alBmpD $alR
    !insertmacro AL_IMG $alChImg choose_keep.bmp
    StrCpy $alBmpK $alR

    ; card frames (1 DIP, recoloured by the choice), then the two radio buttons, then glyphs and texts
    !insertmacro AL_LBL $alBdD $alDlg 256 64 440 46 ${AL_SS_FILL} "" "${AL_HAIR2}" "${AL_HAIR2}" ""
    !insertmacro AL_LBL $alBdK $alDlg 256 12 440 46 ${AL_SS_FILLG} "" "${AL_ACCENT}" "${AL_ACCENT}" ""
    !insertmacro AL_NSD $alRdD 257 65 438 44 ${AL_WS_RADIO2} $alF13b "${AL_FIELD}" "${AL_FIELD}" "放下：同时删除数据，无法恢复"
    !insertmacro AL_NSD $alRdK 257 13 438 44 ${AL_WS_RADIO1} $alF13b "${AL_FIELD}" "${AL_FIELD}" "留存：只卸载程序，数据保留"
    System::Call 'uxtheme::SetWindowTheme(p $alRdK, w " ", w " ")'
    System::Call 'uxtheme::SetWindowTheme(p $alRdD, w " ", w " ")'
    !insertmacro AL_LBL $alIndK $alDlg 258 14 28 42 ${AL_SS_IND} $alFsym "${AL_ACCENT}" "${AL_FIELD}" "◉"
    !insertmacro AL_LBL $0 $alDlg 292 18 396 22 ${AL_SS_ONE} $alF13b "${AL_TEXT}" "${AL_FIELD}" "留存"
    !insertmacro AL_LBL $0 $alDlg 292 40 396 16 ${AL_SS_ONE} $alF12 "${AL_TEXT2}" "${AL_FIELD}" "只卸载程序，数据保留。重新安装后自动接上。"
    !insertmacro AL_LBL $alIndD $alDlg 258 66 28 42 ${AL_SS_IND} $alFsym "${AL_ACCENT}" "${AL_FIELD}" "○"
    !insertmacro AL_LBL $0 $alDlg 292 70 396 22 ${AL_SS_ONE} $alF13b "${AL_TEXT}" "${AL_FIELD}" "放下"
    !insertmacro AL_LBL $0 $alDlg 292 92 396 16 ${AL_SS_ONE} $alF12 "${AL_TEXT2}" "${AL_FIELD}" "同时删除数据，无法恢复。"

    ; the paper list: what stays / goes, laid out by un.alChooseShow (label, path and text per row)
    !insertmacro AL_LBL $alPaper $alDlg 256 118 440 200 ${AL_SS_FILL} "" "${AL_PAPER}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChBar $alDlg 256 118 3 200 ${AL_SS_FILL} "" "${AL_GOLD}" "${AL_GOLD}" ""
    !insertmacro AL_LBL $alChL1 $alDlg 272 126 40 16 ${AL_SS_ONE} $alF11 "${AL_INK2}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChP1 $alDlg 316 126 370 15 ${AL_SS_ONE} $alFm "${AL_INK}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChV1 $alDlg 316 126 370 16 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChL2 $alDlg 272 126 40 16 ${AL_SS_ONE} $alF11 "${AL_INK2}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChP2 $alDlg 316 126 370 15 ${AL_SS_ONE} $alFm "${AL_INK}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChV2 $alDlg 316 126 370 16 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChL3 $alDlg 272 126 40 16 ${AL_SS_ONE} $alF11 "${AL_INK2}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChP3 $alDlg 316 126 370 15 ${AL_SS_ONE} $alFm "${AL_INK}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChV3 $alDlg 316 126 370 16 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChL4 $alDlg 272 126 40 16 ${AL_SS_ONE} $alF11 "${AL_INK2}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChP4 $alDlg 316 126 370 15 ${AL_SS_ONE} $alFm "${AL_INK}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $alChV4 $alDlg 316 126 370 16 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" ""
    ; a "copy" button for each path row, hidden until a tight tier shortens the path
    !insertmacro AL_NSD $alChC1 642 126 44 18 ${AL_WS_BTN} $alF11 "" "" "复制"
    !insertmacro AL_NSD $alChC2 642 126 44 18 ${AL_WS_BTN} $alF11 "" "" "复制"
    !insertmacro AL_NSD $alChC3 642 126 44 18 ${AL_WS_BTN} $alF11 "" "" "复制"
    !insertmacro AL_NSD $alChC4 642 126 44 18 ${AL_WS_BTN} $alF11 "" "" "复制"
    ${NSD_OnClick} $alChC1 un.alCopyClick
    ${NSD_OnClick} $alChC2 un.alCopyClick
    ${NSD_OnClick} $alChC3 un.alCopyClick
    ${NSD_OnClick} $alChC4 un.alCopyClick
    System::Call 'uxtheme::SetWindowTheme(p $alChC1, w "DarkMode_Explorer", p 0)'
    System::Call 'uxtheme::SetWindowTheme(p $alChC2, w "DarkMode_Explorer", p 0)'
    System::Call 'uxtheme::SetWindowTheme(p $alChC3, w "DarkMode_Explorer", p 0)'
    System::Call 'uxtheme::SetWindowTheme(p $alChC4, w "DarkMode_Explorer", p 0)'
    SetCtlColors $alChC1 "${AL_TEXT}" "${AL_PAPER}"
    SetCtlColors $alChC2 "${AL_TEXT}" "${AL_PAPER}"
    SetCtlColors $alChC3 "${AL_TEXT}" "${AL_PAPER}"
    SetCtlColors $alChC4 "${AL_TEXT}" "${AL_PAPER}"
    ShowWindow $alChC1 ${SW_HIDE}
    ShowWindow $alChC2 ${SW_HIDE}
    ShowWindow $alChC3 ${SW_HIDE}
    ShowWindow $alChC4 ${SW_HIDE}

    ; her line (under the paper, which never reaches below 318), and the credits under the picture, kept
    ; narrower than the picture so they never cut into the paper
    !insertmacro AL_LBL $alChHerBar $alDlg 256 326 2 24 ${AL_SS_FILL} "" "${AL_HER_BAR}" "${AL_HER_BAR}" ""
    !insertmacro AL_LBL $alChHer $alDlg 266 326 430 24 ${AL_SS_ONE} $alF13 "${AL_ACCENT}" "${AL_PAGE}" ""
    !insertmacro AL_CREDW $alDlg 24 300 216 "${AL_PAGE}" "${AL_C_AI}"
    !insertmacro AL_CREDW $alDlg 24 314 216 "${AL_PAGE}" "${AL_C_FACE}"

    SendMessage $alRdK ${BM_SETCHECK} ${BST_CHECKED} 0
    ${NSD_OnClick} $alRdK un.alChooseApply
    ${NSD_OnClick} $alRdD un.alChooseApply
    Call un.alChooseShow
    ; Nothing on this page takes text, so nothing shows a caret: the focus starts on the primary button (posted, so it is
    ; handled after NSIS has done its own focusing), not on a radio button.
    System::Call 'user32::HideCaret(p 0)'
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i 0x0028, p $mui.Button.Next, p 1)'
    nsDialogs::Show
  FunctionEnd

  ; click on either radio button
  Function un.alChooseApply
    Pop $0
    Call un.alChooseShow
    ; the choice is made: the focus moves on to the primary button, and no caret is left on the page
    System::Call 'user32::HideCaret(p 0)'
    System::Call 'user32::PostMessageW(p $HWNDPARENT, i 0x0028, p $mui.Button.Next, p 1)'
  FunctionEnd

  ; The rows of the paper list for the chosen card, from the running y in $3 (AL_SLOT). The tier ($alMode, see
  ; alSetMode) decides how compact they are: 0 as written, 1 smaller path font and gaps, 2 each path on one line
  ; with a copy button and the API key note on one line, 3 as 2 with shorter texts. With $alDry = 1 it only measures.
  Function un.alChooseRows
    ${If} $alDataFiles != ""
      StrCpy $5 "、$alDataFiles 个文件"
    ${Else}
      StrCpy $5 ""
    ${EndIf}
    ${If} $alPick = 1
      StrCpy $1 "删除"
      StrCpy $2 "$alDataRoot"
      ${If} $alDataEx == 1
        ${If} $alTier >= 3
          StrCpy $4 "整个文件夹，共 $alDataSize$5，不进回收站，无法恢复。便携版共用这份数据，也一并删除。"
        ${Else}
          StrCpy $4 "整个文件夹，共 $alDataSize$5：对话与任务记录、API 密钥、自定义技能、练习目录、设置，以及栖枝浏览器里的登录状态和所有缓存。不进回收站，无法恢复。便携版共用这份数据，也一并删除。"
        ${EndIf}
      ${Else}
        StrCpy $4 "这个文件夹不存在，没有数据可删除。便携版共用这份数据。"
      ${EndIf}
      !insertmacro AL_SLOT 1
      StrCpy $1 "不删"
      StrCpy $2 ""
      ${If} $alTier >= 3
        StrCpy $4 "你的工作文件夹、手动备份的文件，以及你自己登录的 claude、codex 等工具。"
      ${Else}
        StrCpy $4 "你的工作文件夹；手动备份到其他位置的文件；claude、codex 等你自己登录的工具。"
      ${EndIf}
      !insertmacro AL_SLOT 2
      ${If} $alDD != ""
        StrCpy $1 "不删"
        StrCpy $2 "$alDD"
        ${If} $alTier >= 2
          StrCpy $4 "里面的 alight.db 等文件默认不动，要不要删下一页再选。"
        ${ElseIf} $alDDSrc == "env"
          StrCpy $4 "自定义数据目录里的 alight.db 等文件默认不动；要不要一并删除，下一页再选。环境变量 ALIGHT_DATA_DIR 仍指向它，不受卸载影响。"
        ${Else}
          StrCpy $4 "自定义数据目录里的 alight.db 等文件默认不动；要不要一并删除，下一页再选。指向它的设置会随数据文件夹一起删除，重新安装后不会自动接上。"
        ${EndIf}
      ${Else}
        StrCpy $1 ""
        StrCpy $2 ""
        StrCpy $4 ""
      ${EndIf}
      !insertmacro AL_SLOT 3
      StrCpy $1 ""
      StrCpy $2 ""
      StrCpy $4 "API 密钥只是从本机删除，在服务商处仍然有效；要作废请到服务商页面。"
      !insertmacro AL_SLOT 4
    ${Else}
      StrCpy $1 "保留"
      StrCpy $2 "$alDataRoot"
      ${If} $alDataEx == 1
        ${If} $alTier >= 3
          StrCpy $4 "共 $alDataSize。对话与任务记录、API 密钥、技能和浏览器登录状态。重新安装后自动接上。"
        ${Else}
          StrCpy $4 "共 $alDataSize。对话与任务记录、模型服务设置、API 密钥（已用 Windows 加密，仅当前用户可读）、自定义技能、练习目录、窗口与偏好设置、浏览器登录状态。重新安装后自动接上。"
        ${EndIf}
      ${Else}
        StrCpy $4 "这个文件夹不存在，没有数据可保留。"
      ${EndIf}
      !insertmacro AL_SLOT 1
      StrCpy $1 "不动"
      StrCpy $2 ""
      StrCpy $4 "你的工作文件夹与其中的文件；claude、codex 等你自己登录的工具。"
      !insertmacro AL_SLOT 2
      ${If} $alDD != ""
        StrCpy $1 "保留"
        StrCpy $2 "$alDD"
        ${If} $alTier >= 3
          StrCpy $4 "自定义数据目录，在原处，重新安装后接上。"
        ${ElseIf} $alDDSrc == "env"
          StrCpy $4 "自定义数据目录，在原处。由环境变量 ALIGHT_DATA_DIR 指定，重新安装后仍然使用它。"
        ${Else}
          StrCpy $4 "自定义数据目录，在原处。它的位置记在上面的数据文件夹里，重新安装后一并接上。"
        ${EndIf}
      ${ElseIf} $alDDHint == 1
        StrCpy $1 "保留"
        StrCpy $2 ""
        StrCpy $4 "数据目录已改到别处，没有改动。"
      ${Else}
        StrCpy $1 ""
        StrCpy $2 ""
        StrCpy $4 ""
      ${EndIf}
      !insertmacro AL_SLOT 3
      StrCpy $1 ""
      StrCpy $2 ""
      StrCpy $4 ""
      !insertmacro AL_SLOT 4
    ${EndIf}
  FunctionEnd

  ; the picture, the card frames and glyphs, the paper list, her line and the primary button follow the radio buttons
  Function un.alChooseShow
    SendMessage $alRdD ${BM_GETCHECK} 0 0 $0
    ${If} $0 == ${BST_CHECKED}
      ; drop: a gold edge, the picture without the butterfly, the second card framed
      StrCpy $alPick 1
      SendMessage $alChImg ${STM_SETIMAGE} ${IMAGE_BITMAP} $alBmpD
      ShowWindow $alChBar ${SW_SHOW}
      SendMessage $alIndD ${WM_SETTEXT} 0 "STR:◉"
      SendMessage $alIndK ${WM_SETTEXT} 0 "STR:○"
      SetCtlColors $alBdD "${AL_ACCENT}" "${AL_ACCENT}"
      SetCtlColors $alBdK "${AL_HAIR2}" "${AL_HAIR2}"
      SendMessage $alChHer ${WM_SETTEXT} 0 "STR:放下之后，这些不再留着。"
      !insertmacro AL_BAR "返回" "下一步" 96 "取消"
    ${Else}
      StrCpy $alPick 0
      SendMessage $alChImg ${STM_SETIMAGE} ${IMAGE_BITMAP} $alBmpK
      ShowWindow $alChBar ${SW_HIDE}
      SendMessage $alIndK ${WM_SETTEXT} 0 "STR:◉"
      SendMessage $alIndD ${WM_SETTEXT} 0 "STR:○"
      SetCtlColors $alBdK "${AL_ACCENT}" "${AL_ACCENT}"
      SetCtlColors $alBdD "${AL_HAIR2}" "${AL_HAIR2}"
      SendMessage $alChHer ${WM_SETTEXT} 0 "STR:数据原样留在原处。"
      !insertmacro AL_BAR "返回" "卸载" 96 "取消"
    ${EndIf}
    ; the paper takes the height of its rows, at most down to 318 (her line is at 326). The rows are measured with
    ; the normal layout first, then with each tighter tier until they fit; the last tier always does.
    StrCpy $alTier 0
    ${Do}
      StrCpy $alA $alTier
      Call un.alSetMode
      StrCpy $alDry 1
      StrCpy $3 126
      Call un.alChooseRows
      IntOp $alH $3 - 118
      ${If} $alH <= 200
      ${OrIf} $alTier >= 3
        ${ExitDo}
      ${EndIf}
      IntOp $alTier $alTier + 1
    ${Loop}
    StrCpy $alDry 0
    StrCpy $3 126
    Call un.alChooseRows
    StrCpy $alA 0
    Call un.alSetMode
    ; (the last row's gap is the bottom margin)
    IntOp $alH $3 - 118
    ${If} $alH > 200
      StrCpy $alH 200
    ${EndIf}
    !insertmacro AL_POS $alPaper 256 118 440 $alH
    !insertmacro AL_POS $alChBar 256 118 3 $alH
    System::Call 'user32::RedrawWindow(p $alDlg, p 0, p 0, i 0x181)' ; RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW
  FunctionEnd

  ; only here can the delete flag become 1; going back to this page clears it again (see the Pre function)
  Function un.alChooseLeave
    SendMessage $alRdD ${BM_GETCHECK} 0 0 $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $alDrop 1
    ${Else}
      StrCpy $alDrop ""
    ${EndIf}
  FunctionEnd

  ; U3 layout, measured: $alTier (0..3) -> $alR = the bottom edge of the confirmation box. The page is one flow
  ; from y 6: the custom data folder's box and path, the paper table (data root path, one line per group), the
  ; gold-edged warning, the box. The credit is pinned at 348, so the box must end by 344. Tier 0 as written,
  ; 1 smaller path font, 2 the custom folder's path on one line (copy button), 3 the data root too.
  Function un.alConfirmH
    Push $0
    StrCpy $0 6
    StrCpy $alDry 1
    ${If} $alDD != ""
      IntOp $0 $0 + 22
      StrCpy $alA $alTier
      ${If} $alA > 2
        StrCpy $alA 2
      ${EndIf}
      Call un.alSetMode
      !insertmacro AL_PATHCP $alDlg 46 $0 650 "${AL_TEXT2}" "${AL_PAGE}" "${AL_TEXT}" "$alDD"
      IntOp $0 $0 + $alH
      IntOp $0 $0 + 8
    ${EndIf}
    StrCpy $alA 0
    ${If} $alTier >= 3
      StrCpy $alA 2
    ${EndIf}
    Call un.alSetMode
    !insertmacro AL_PATHCP $alDlg 92 $0 500 "${AL_INK}" "${AL_PAPER}" "${AL_TEXT}" "$alDataRoot"
    IntOp $0 $0 + 68
    IntOp $0 $0 + $alH
    IntOp $alH $alRows * 16
    IntOp $0 $0 + $alH
    IntOp $0 $0 + 106 ; 8, the warning (70), 8, the box (20)
    StrCpy $alDry 0
    StrCpy $alA 0
    Call un.alSetMode
    StrCpy $alR $0
    Pop $0
  FunctionEnd

  ; U3 delete confirmation (only for "drop"): what exactly goes, sized per group
  Function un.alConfirmPre
    ${If} $alDrop != 1
    ${OrIf} ${Silent}
    ${OrIf} ${isUpdated}
      Abort
    ${EndIf}
    Call un.alScanData
    Call un.alFindDD

    ; the table, three columns of CRLF lines: place, content, size
    StrCpy $alT1 ""
    StrCpy $alT2 ""
    StrCpy $alT3 ""
    StrCpy $alSumKB 0
    StrCpy $alSumR 0
    StrCpy $alSumN 0
    StrCpy $alRows 0
    ${If} $alDataEx == 1
      !insertmacro AL_GROUP "alight.db、-wal、-shm、backups\" "对话与任务记录" "alight.db" "alight.db-wal" "alight.db-shm" "backups"
      !insertmacro AL_GROUP "model-keys.json" "API 密钥（Windows 加密）" "model-keys.json" "" "" ""
      !insertmacro AL_GROUP "store-config.json、services.json 等" "模型服务、目录信任、窗口状态" "store-config.json" "services.json" "" ""
      !insertmacro AL_GROUP "skills\、workspaces\" "自定义技能、练习目录" "skills" "workspaces" "" ""
      !insertmacro AL_GROUP "Partitions\、Local Storage\、Network\" "栖枝浏览器的登录状态" "Partitions" "Local Storage" "Network" ""
      IntOp $0 $alDataKB - $alSumKB
      IntOp $1 $alDataFiles - $alSumN
      IntOp $2 $alDataR - $alSumR
      ${If} $2 < 0
        IntOp $2 $2 + 1024
        IntOp $0 $0 - 1
      ${EndIf}
      ${If} $0 > 0
      ${OrIf} $1 > 0
        ${If} $0 < 0
          StrCpy $0 0
        ${EndIf}
        StrCpy $alA $0
        StrCpy $alB $2
        Call un.alFmtSize
        StrCpy $0 "其余（Cache\、GPUCache\、logs\ 等）$\r$\n"
        StrCpy $alT1 "$alT1$0"
        IntOp $alRows $alRows + 1
        StrCpy $0 "缓存与日志$\r$\n"
        StrCpy $alT2 "$alT2$0"
        StrCpy $0 "$alR$\r$\n"
        StrCpy $alT3 "$alT3$0"
      ${EndIf}
      StrCpy $2 "$alDataFiles 个文件，不进回收站"
      StrCpy $3 $alDataSize
    ${Else}
      StrCpy $alRows 1
      StrCpy $alT1 "没有找到数据文件夹，没有数据可删除。$\r$\n"
      StrCpy $2 "不进回收站"
      StrCpy $3 "0 KB"
    ${EndIf}

    ; the tightest tier that makes the page fit (the last one always does)
    StrCpy $alTier 0
    ${Do}
      Call un.alConfirmH
      ${If} $alR <= 344
      ${OrIf} $alTier >= 3
        ${ExitDo}
      ${EndIf}
      IntOp $alTier $alTier + 1
    ${Loop}

    !insertmacro MUI_HEADER_TEXT "确认删除数据" "确认后才会开始删除；返回上一步不会改动任何东西。"
    nsDialogs::Create 1018
    Pop $alDlg
    ${If} $alDlg == error
      Abort
    ${EndIf}
    SetCtlColors $alDlg "${AL_TEXT}" "${AL_PAGE}"

    ; $4 is the running y. The custom data folder comes first, on its own line above the table, apart from the
    ; confirmation box at the bottom: ticking one never ticks the other.
    StrCpy $4 6
    ${If} $alDD != ""
      !insertmacro AL_CHKNEW $alChkD $alDlg 24 $4 672 20 "${AL_TEXT2}" "${AL_PAGE}" "同时删除自定义数据目录里的数据库文件（只删 alight.db 及其 -wal、-shm、备份）" un.alChkDClick
      IntOp $4 $4 + 22
      StrCpy $alA $alTier
      ${If} $alA > 2
        StrCpy $alA 2
      ${EndIf}
      Call un.alSetMode
      !insertmacro AL_PATHCP $alDlg 46 $4 650 "${AL_TEXT2}" "${AL_PAGE}" "${AL_TEXT}" "$alDD"
      IntOp $4 $4 + $alH
      IntOp $4 $4 + 8
    ${EndIf}

    ; the paper table: made first (so the rows land above it) and sized once its rows are known
    !insertmacro AL_LBL $alPaper $alDlg 24 $4 672 200 ${AL_SS_FILL} "" "${AL_PAPER}" "${AL_PAPER}" ""
    IntOp $5 $4 + 8
    !insertmacro AL_LBL $0 $alDlg 36 $5 232 16 ${AL_SS_ONE} $alF11 "${AL_INK2}" "${AL_PAPER}" "位置"
    !insertmacro AL_LBL $0 $alDlg 286 $5 300 16 ${AL_SS_ONE} $alF11 "${AL_INK2}" "${AL_PAPER}" "内容"
    !insertmacro AL_LBL $0 $alDlg 606 $5 78 16 ${AL_SS_ONE} $alF11 "${AL_INK2}" "${AL_PAPER}" "大小"
    IntOp $5 $4 + 28
    !insertmacro AL_LBL $0 $alDlg 36 $5 52 16 ${AL_SS_ONE} $alF11 "${AL_INK2}" "${AL_PAPER}" "数据根"
    IntOp $5 $4 + 27
    StrCpy $alA 0
    ${If} $alTier >= 3
      StrCpy $alA 2
    ${EndIf}
    Call un.alSetMode
    !insertmacro AL_PATHCP $alDlg 92 $5 500 "${AL_INK}" "${AL_PAPER}" "${AL_TEXT}" "$alDataRoot"
    StrCpy $alA 0
    Call un.alSetMode
    IntOp $5 $5 + $alH
    IntOp $5 $5 + 6
    IntOp $6 $alRows * 16
    IntOp $6 $6 + 2
    !insertmacro AL_LBL $0 $alDlg 36 $5 240 $6 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" "$alT1"
    !insertmacro AL_LBL $0 $alDlg 286 $5 312 $6 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" "$alT2"
    !insertmacro AL_LBL $0 $alDlg 606 $5 80 $6 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" "$alT3"
    IntOp $5 $5 + $6
    IntOp $5 $5 + 4
    !insertmacro AL_LBL $0 $alDlg 36 $5 648 1 ${AL_SS_FILL} "" "${AL_INK2}" "${AL_INK2}" ""
    IntOp $5 $5 + 5
    !insertmacro AL_LBL $0 $alDlg 36 $5 240 16 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" "合计"
    !insertmacro AL_LBL $0 $alDlg 286 $5 312 16 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" "$2"
    !insertmacro AL_LBL $0 $alDlg 606 $5 80 16 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" "$3"
    IntOp $5 $5 + 24
    IntOp $alH $5 - $4
    !insertmacro AL_POS $alPaper 24 $4 672 $alH
    IntOp $4 $5 + 8

    ; the gold-edged warning: three plain lines, no path in them
    !insertmacro AL_LBL $0 $alDlg 24 $4 672 70 ${AL_SS_FILL} "" "${AL_FIELD}" "${AL_FIELD}" ""
    !insertmacro AL_LBL $0 $alDlg 24 $4 3 70 ${AL_SS_FILL} "" "${AL_GOLD}" "${AL_GOLD}" ""
    IntOp $5 $4 + 11
    !insertmacro AL_BMP $0 $alDlg warn_gold.bmp 36 $5 18 18 0
    StrCpy $6 "不删：工作文件夹、手动备份到其他位置的文件。"
    ${If} $alDD != ""
      StrCpy $6 "不删：工作文件夹、手动备份到其他位置的文件、自定义数据目录里的其他文件。"
    ${EndIf}
    IntOp $5 $4 + 8
    !insertmacro AL_LBL $0 $alDlg 64 $5 620 54 ${AL_SS_ONE} $alF12 "${AL_TEXT}" "${AL_FIELD}" "无法恢复。便携版与安装版共用这份数据，也会一并删除。$\r$\nAPI 密钥只是从本机删除，在服务商处仍然有效；要作废请到服务商页面。$\r$\n$6"
    IntOp $4 $4 + 78

    ; the confirmation, alone at the bottom; the credit is pinned under it (the page above is measured to leave room)
    !insertmacro AL_CHKNEW $alChkV $alDlg 24 $4 672 20 "${AL_TEXT}" "${AL_PAGE}" "我已核对以上内容，同意永久删除。" un.alConfirmClick
    !insertmacro AL_CRED $alDlg 24 348 "${AL_PAGE}" "${AL_C_FACE}"
    !insertmacro AL_BAR "返回" "卸载并删除数据" 132 "取消"
    ; until the box is ticked the button is disabled and says so (a disabled and an enabled button otherwise
    ; differ only in the grey of the text)
    EnableWindow $mui.Button.Next 0
    SendMessage $mui.Button.Next ${WM_SETTEXT} 0 "STR:请先核对"
    System::Call 'user32::SetFocus(p $alChkV)'
    nsDialogs::Show
  FunctionEnd

  ; the confirmation box switches the primary button
  Function un.alConfirmClick
    Pop $0
    StrCpy $alA $alChkV
    Call un.alChkSync
    SendMessage $alChkV ${BM_GETCHECK} 0 0 $1
    ${If} $1 == ${BST_CHECKED}
      EnableWindow $mui.Button.Next 1
      SendMessage $mui.Button.Next ${WM_SETTEXT} 0 "STR:卸载并删除数据"
    ${Else}
      EnableWindow $mui.Button.Next 0
      SendMessage $mui.Button.Next ${WM_SETTEXT} 0 "STR:请先核对"
    ${EndIf}
  FunctionEnd

  ; the box for the custom data folder: only its glyph changes
  Function un.alChkDClick
    Pop $0
    StrCpy $alA $alChkD
    Call un.alChkSync
  FunctionEnd

  ; the box for the custom data folder is separate: ticking the confirmation does not authorise it
  Function un.alConfirmLeave
    SendMessage $alChkV ${BM_GETCHECK} 0 0 $0
    ${If} $0 != ${BST_CHECKED}
      Abort
    ${EndIf}
    StrCpy $alDelDD ""
    ${If} $alDD != ""
      SendMessage $alChkD ${BM_GETCHECK} 0 0 $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $alDelDD 1
      ${EndIf}
    ${EndIf}
  FunctionEnd

  ; U5 uninstalling: band picture, status line, progress bar and the four-line inventory, the data folder's
  ; path on its own line(s) under it
  Function un.alInstShow
    !insertmacro AL_POS $mui.InstFilesPage 0 64 720 368
    SetCtlColors $mui.InstFilesPage "${AL_TEXT}" "${AL_PAGE}"
    !insertmacro AL_BMP $0 $mui.InstFilesPage band.bmp 0 0 720 160 1
    ShowWindow $mui.InstFilesPage.ShowLogButton ${SW_HIDE}
    ShowWindow $mui.InstFilesPage.Log ${SW_HIDE}
    !insertmacro AL_POS $mui.InstFilesPage.Text 40 172 640 20
    SendMessage $mui.InstFilesPage.Text ${WM_SETFONT} $alF12 0
    SetCtlColors $mui.InstFilesPage.Text "${AL_TEXT}" "${AL_PAGE}"
    ; the section starts with a check for a running app (PowerShell, a few seconds): say only that, until it
    ; reports what it is doing
    SendMessage $mui.InstFilesPage.Text ${WM_SETTEXT} 0 "STR:正在准备。"
    !insertmacro AL_POS $mui.InstFilesPage.ProgressBar 40 198 640 8
    System::Call 'uxtheme::SetWindowTheme(p $mui.InstFilesPage.ProgressBar, w " ", w " ")'
    SendMessage $mui.InstFilesPage.ProgressBar 0x0409 0 ${AL_BLUE_REF}  ; PBM_SETBARCOLOR
    SendMessage $mui.InstFilesPage.ProgressBar 0x2001 0 ${AL_FIELD_REF} ; PBM_SETBKCOLOR
    !insertmacro AL_INVROW 1 218 "数据"
    !insertmacro AL_INVROW 2 236 "程序文件"
    !insertmacro AL_INVROW 3 254 "快捷方式"
    !insertmacro AL_INVROW 4 272 "卸载登记"
    ${If} $alDrop != 1
      !insertmacro AL_INV 1 c "已保留"
    ${EndIf}
    !insertmacro AL_LBL $0 $mui.InstFilesPage 40 296 64 18 ${AL_SS_ONE} $alF12 "${AL_TEXT3}" "${AL_PAGE}" "数据位置"
    !insertmacro AL_PATHBOX $mui.InstFilesPage 112 296 568 "${AL_TEXT2}" "${AL_PAGE}" "$alDataRoot"
    !insertmacro AL_CRED $mui.InstFilesPage 24 336 "${AL_PAGE}" "${AL_C_AI}"
    !insertmacro AL_CRED $mui.InstFilesPage 24 350 "${AL_PAGE}" "${AL_C_FACE}"
    !insertmacro AL_BAR "返回" "下一步" 96 "取消"
    ; nothing to press while it works (NSIS keeps Cancel disabled for the whole files page)
    ShowWindow $mui.Button.Back ${SW_HIDE}
    ShowWindow $mui.Button.Next ${SW_HIDE}
  FunctionEnd

  ; The data deletion. Entered only when the user chose "drop", confirmed, and the run is neither silent
  ; nor an update. Every entry-point check must pass or nothing is touched; deletion goes top-level entry
  ; by entry, never with RMDir /r (it follows junctions), and every entry is checked afterwards.
  Function un.alDropData
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    StrCpy $alFailCount 0
    StrCpy $alFailList ""
    StrCpy $alFailCopy ""
    StrCpy $alFailShown 0
    StrCpy $alWalkHit 0
    ; (NSIS keeps Cancel disabled for the whole files page: nothing to switch off or back on here)
    !insertmacro AL_INV 1 b "进行中"

    ; a. a plain absolute path that is not a link (and, in the test build, under the sandbox)
    StrCpy $alA $alDataRoot
    Call un.alSafePath
    ${If} $alR != "ok"
      !ifdef AL_TEST_BUILD
        SetDetailsPrint both
        DetailPrint "AL_ASSERT"
        Abort
      !endif
      System::Call 'kernel32::GetFileAttributesW(w "$alDataRoot") i.r0'
      ${If} $0 <> -1
        IntOp $0 $0 & 0x400
        ${If} $0 <> 0
          StrCpy $alA "$alDataRoot"
          StrCpy $alNote "（是链接，没有删除）"
        ${Else}
          StrCpy $alA "$alDataRoot"
          StrCpy $alNote "（没有通过安全检查，没有删除）"
        ${EndIf}
        Call un.alFailAdd
      ${EndIf}
      Goto drop_dd
    ${EndIf}
    ; the folder must be named alight-desk
    StrCpy $0 $alDataRoot 12 -12
    ${If} $0 != "\alight-desk"
      !ifdef AL_TEST_BUILD
        SetDetailsPrint both
        DetailPrint "AL_ASSERT"
        Abort
      !endif
      StrCpy $alA "$alDataRoot"
      StrCpy $alNote "（名称不对，没有删除）"
      Call un.alFailAdd
      Goto drop_dd
    ${EndIf}

    StrCpy $alDataEx 0
    System::Call 'kernel32::GetFileAttributesW(w "$alDataRoot") i.r0'
    ${If} $0 <> -1
      StrCpy $alDataEx 1
      FindFirst $1 $2 "$alDataRoot\*"
      ${Do}
        ${If} $2 == ""
          ${ExitDo}
        ${EndIf}
        ${If} $2 != "."
        ${AndIf} $2 != ".."
          StrCpy $3 "$alDataRoot\$2"
          SetDetailsPrint both
          DetailPrint "正在删除数据：$2"
          SetDetailsPrint none
          System::Call 'kernel32::GetFileAttributesW(w "$3") i.r4'
          StrCpy $alA $3
          Call un.alCharsOK
          IntOp $5 $4 & 0x400
          ${If} $5 <> 0
            ; a link: remove the link itself
            ${If} $alR == "ok"
              nsExec::Exec '"$SYSDIR\cmd.exe" /c rmdir "\\?\$3"'
              Pop $6
            ${EndIf}
            ${If} ${FileExists} "$3"
              Delete "$3"
            ${EndIf}
          ${Else}
            IntOp $5 $4 & 0x10
            ${If} $5 <> 0
              ; a folder: cmd's rd does not follow junctions inside it (RMDir /r does). Not for names cmd would rewrite.
              ; The long-path form (backslash backslash question mark backslash) is what lets it remove a tree
              ; deeper than 260 characters; without it rd prints "directory not empty", exits 0 and leaves the branch.
              ${If} $alR == "ok"
                nsExec::Exec '"$SYSDIR\cmd.exe" /c rd /s /q "\\?\$3"'
                Pop $6
              ${EndIf}
            ${Else}
              Delete "$3"
            ${EndIf}
          ${EndIf}
          ${If} ${FileExists} "$3"
            ; a folder that stayed: name the files that hold it (up to the first few), not just the folder
            StrCpy $alWalkHit 0
            IntOp $5 $4 & 0x10
            IntOp $6 $4 & 0x400
            ${If} $5 <> 0
            ${AndIf} $6 = 0
              Push $3
              Call un.alFailWalk
            ${EndIf}
            ${If} $alWalkHit = 0
              StrCpy $alA $3
              Call un.alFailAdd
            ${EndIf}
          ${EndIf}
        ${EndIf}
        FindNext $1 $2
      ${Loop}
      FindClose $1
      RMDir "$alDataRoot"
      ${If} ${FileExists} "$alDataRoot"
      ${AndIf} $alFailCount = 0
        StrCpy $alA $alDataRoot
        Call un.alFailAdd
      ${EndIf}
    ${EndIf}

    drop_dd:
    ; the custom data folder: only on its own tick, only these file names, never the folder as a whole
    ${If} $alDelDD == 1
    ${AndIf} $alDD != ""
      StrCpy $alA $alDD
      Call un.alSafeDD
      ${If} $alR == "ok"
        SetDetailsPrint both
        DetailPrint "正在删除数据目录里的数据库文件。"
        SetDetailsPrint none
        !insertmacro AL_DELFILE "$alDD\alight.db"
        !insertmacro AL_DELFILE "$alDD\alight.db-wal"
        !insertmacro AL_DELFILE "$alDD\alight.db-shm"
        System::Call 'kernel32::GetFileAttributesW(w "$alDD\backups") i.r0'
        ${If} $0 <> -1
          IntOp $0 $0 & 0x400
          ${If} $0 = 0
            FindFirst $1 $2 "$alDD\backups\alight-*.db"
            ${Do}
              ${If} $2 == ""
                ${ExitDo}
              ${EndIf}
              !insertmacro AL_DELFILE "$alDD\backups\$2"
              FindNext $1 $2
            ${Loop}
            FindClose $1
            RMDir "$alDD\backups"
          ${EndIf}
        ${EndIf}
        RMDir "$alDD"
      ${Else}
        StrCpy $alA "$alDD"
        StrCpy $alNote "（没有通过安全检查，没有删除）"
        Call un.alFailAdd
      ${EndIf}
    ${EndIf}

    ; what the row says is what was checked (the path is on its own line under the rows)
    SetDetailsPrint both
    ${If} $alFailCount > 0
      !insertmacro AL_INV 1 c "有 $alFailCount 项没能删除"
    ${ElseIf} $alDataEx != 1
      ${If} $alDelDD == 1
        !insertmacro AL_INV 1 c "没有找到默认的数据文件夹；自定义目录里的数据库文件已删除"
      ${Else}
        !insertmacro AL_INV 1 c "没有找到数据文件夹，没有需要删除的"
      ${EndIf}
    ${Else}
      !insertmacro AL_INV 1 c "已删除"
    ${EndIf}
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; The auto-updater's download cache: %LOCALAPPDATA%\<package name>-updater (electron-updater keeps the last
  ; downloaded installer there, around 200 MB). It is not user data, so it goes whether the data is kept or dropped.
  ; NOT on an update run: the new installer runs from that very folder and calls this uninstaller with --updated and
  ; /KEEP_APP_DATA (installUtil.nsh), so either switch means "leave it alone". Removed entry by entry like the data:
  ; a link is removed as a link and never followed, a folder with cmd's rd (not RMDir /r), the folder itself without
  ; /r. The path is asserted first: it must be <LocalAppData>\<package name>-updater exactly. $alCacheState: "" =
  ; nothing there or not touched, 1 = removed, 2 = something stayed.
  Function un.alDropCache
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    Push $6
    StrCpy $alCacheState ""
    ${If} ${isUpdated}
      Goto cache_end
    ${EndIf}
    ClearErrors
    ${GetParameters} $0
    ${GetOptions} $0 "/KEEP_APP_DATA" $1
    ${IfNot} ${Errors}
      ClearErrors
      Goto cache_end
    ${EndIf}
    ClearErrors
    ; always the current user's local app data, also for an all-users install
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}
    StrCpy $0 "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"
    StrCpy $6 "$LOCALAPPDATA\"
    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
    ; assertions: an absolute path under the local app data folder, the expected last name, nothing odd in it
    StrLen $1 $6
    ${If} $1 < 6
      Goto cache_end
    ${EndIf}
    StrCpy $2 $0 $1
    ${If} $2 != $6
      Goto cache_end
    ${EndIf}
    StrCpy $2 $6 1 1
    ${If} $2 != ":"
      Goto cache_end
    ${EndIf}
    StrCpy $alA $0
    Call un.alCharsOK
    ${If} $alR != "ok"
      Goto cache_end
    ${EndIf}
    StrLen $1 "${APP_PACKAGE_NAME}-updater"
    ${If} $1 < 8
      Goto cache_end
    ${EndIf}
    IntOp $1 $1 + 1
    StrCpy $2 $0 "" -$1
    ${If} $2 != "\${APP_PACKAGE_NAME}-updater"
      Goto cache_end
    ${EndIf}
    ; there, a folder, not a link
    System::Call 'kernel32::GetFileAttributesW(w "$0") i.r2'
    ${If} $2 = -1
      Goto cache_end
    ${EndIf}
    IntOp $3 $2 & 0x400
    ${If} $3 <> 0
      Goto cache_end
    ${EndIf}
    IntOp $3 $2 & 0x10
    ${If} $3 = 0
      Goto cache_end
    ${EndIf}
    ${IfNot} ${Silent}
      SetDetailsPrint both
      DetailPrint "正在移除更新缓存。"
      SetDetailsPrint none
    ${EndIf}
    StrCpy $alCacheState 1
    FindFirst $1 $5 "$0\*"
    ${Do}
      ${If} $5 == ""
        ${ExitDo}
      ${EndIf}
      ${If} $5 != "."
      ${AndIf} $5 != ".."
        StrCpy $6 "$0\$5"
        System::Call 'kernel32::GetFileAttributesW(w "$6") i.r2'
        StrCpy $alA $6
        Call un.alCharsOK
        IntOp $3 $2 & 0x400
        ${If} $3 <> 0
          ; a link: remove the link itself
          ${If} $alR == "ok"
            nsExec::Exec '"$SYSDIR\cmd.exe" /c rmdir "\\?\$6"'
            Pop $4
          ${EndIf}
          ${If} ${FileExists} "$6"
            Delete "$6"
          ${EndIf}
        ${Else}
          IntOp $3 $2 & 0x10
          ${If} $3 <> 0
            ${If} $alR == "ok"
              nsExec::Exec '"$SYSDIR\cmd.exe" /c rd /s /q "\\?\$6"'
              Pop $4
            ${EndIf}
          ${Else}
            SetFileAttributes "$6" NORMAL
            Delete "$6"
          ${EndIf}
        ${EndIf}
        ${If} ${FileExists} "$6"
          StrCpy $alCacheState 2
        ${EndIf}
      ${EndIf}
      FindNext $1 $5
    ${Loop}
    FindClose $1
    RMDir "$0"
    ${If} ${FileExists} "$0"
      StrCpy $alCacheState 2
    ${EndIf}
    cache_end:
    ClearErrors
    Pop $6
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; the end of the run: the other three inventory rows. They say what was found, not what was meant to happen:
  ; the program folder, the two shortcuts and the uninstall entry are looked at once the section is over.
  Function un.onUninstSuccess
    ${IfNot} ${Silent}
      StrCpy $alLeftText ""
      StrCpy $alProgLeft 0
      ${If} ${FileExists} "$INSTDIR\*.*"
        StrCpy $alProgLeft 1
        StrCpy $alLeftText "程序文件夹里还有文件"
        !insertmacro AL_INV 2 c "没有完全移除，文件夹里还有文件"
      ${ElseIf} $alCacheState == 1
        !insertmacro AL_INV 2 c "已移除，含更新缓存"
      ${Else}
        !insertmacro AL_INV 2 c "已移除"
      ${EndIf}
      ${If} $alCacheState == 2
        ${If} $alLeftText == ""
          StrCpy $alLeftText "更新缓存没有移除"
        ${Else}
          StrCpy $alLeftText "$alLeftText、更新缓存没有移除"
        ${EndIf}
      ${EndIf}
      ${If} ${FileExists} "$oldDesktopLink"
      ${OrIf} ${FileExists} "$oldStartMenuLink"
        ${If} $alLeftText == ""
          StrCpy $alLeftText "快捷方式没有移除"
        ${Else}
          StrCpy $alLeftText "$alLeftText、快捷方式没有移除"
        ${EndIf}
        !insertmacro AL_INV 3 c "没有移除"
      ${Else}
        !insertmacro AL_INV 3 c "已移除"
      ${EndIf}
      ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayName"
      ${If} $0 != ""
        ${If} $alLeftText == ""
          StrCpy $alLeftText "卸载登记没有移除"
        ${Else}
          StrCpy $alLeftText "$alLeftText、卸载登记没有移除"
        ${EndIf}
        !insertmacro AL_INV 4 c "没有移除"
      ${Else}
        !insertmacro AL_INV 4 c "已移除"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  ; the "open the data folder" box: a click redraws its glyph
  Function un.alReadmeChk
    Pop $0
    StrCpy $alA $0
    Call un.alChkSync
  FunctionEnd

  ; "open the data folder" box on the finish page (never ticked by default; test builds do not open anything)
  Function un.alOpenData
    !ifndef AL_TEST_BUILD
      ExecShell "open" "$alDataRoot"
    !endif
  FunctionEnd

  ; ---- U6 finish: keep / drop / part of the data could not be deleted ----
  ; All of it stays inside x 28..324: the solid left plate of the pictures ends at 330, and what is made of
  ; opaque statics (title, paper, her line, the box, credits) must not reach the night picture. Like the install
  ; finish page it is flowed: the boxes and credits at the bottom are anchored with their room reserved, the paper
  ; runs down from the title and, if the rows do not fit, is laid out again with a tighter tier (see AL_RTXT).

  ; The receipt rows of the keep / drop finish page, from the running y in $3. With $alDry = 1 they only measure.
  Function un.alRcpRows
    ${If} $alDrop == 1
      ${If} $alLeftText == ""
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "已删除" "$alRmText"
      ${Else}
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "未移除" "$alLeftText。可能正被其他程序占用，关闭后可手动处理。"
      ${EndIf}
      ${If} $alDataEx == 1
        !insertmacro AL_RPATH $mui.FinishPage 42 104 208 "已删除" "$alDataRoot"
        ${If} $alDataFiles != ""
          StrCpy $1 "共 $alDataFiles 个文件、$alDataSize，没有留下副本"
        ${Else}
          StrCpy $1 "共 $alDataSize，没有留下副本"
        ${EndIf}
        !insertmacro AL_TUCK
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "$1"
      ${Else}
        !insertmacro AL_RPATH $mui.FinishPage 42 104 208 "数据" "$alDataRoot"
        !insertmacro AL_TUCK
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "没有找到这个文件夹，没有需要删除的"
      ${EndIf}
      ${If} $alDD != ""
        ${If} $alDelDD == 1
          !insertmacro AL_RPATH $mui.FinishPage 42 104 208 "已删除" "$alDD"
          !insertmacro AL_TUCK
          !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "里面的 alight.db 及其 -wal、-shm、备份"
          ${If} $alDDSrc == "env"
            !insertmacro AL_TUCK
            !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "环境变量 ALIGHT_DATA_DIR 仍指向这里，卸载程序不改它。"
          ${EndIf}
        ${Else}
          !insertmacro AL_RPATH $mui.FinishPage 42 104 208 "数据目录" "$alDD"
          !insertmacro AL_TUCK
          ${If} $alDDSrc == "env"
            ${If} $alMode >= 3
              !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "没有改动；ALIGHT_DATA_DIR 仍指向它。"
            ${Else}
              !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "没有改动；环境变量 ALIGHT_DATA_DIR 仍指向它，重新安装后仍使用它。"
            ${EndIf}
          ${ElseIf} $alMode >= 3
            !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "没有改动；重新安装后不会自动接上。"
          ${Else}
            !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "没有改动；指向它的设置已随数据文件夹删除，重新安装后不会自动接上。"
          ${EndIf}
        ${EndIf}
      ${ElseIf} $alDDHint == 1
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "数据目录" "数据目录已改到别处，没有改动。"
      ${EndIf}
      !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "不在其中" "手动备份到其他位置的文件、你的工作文件夹"
    ${Else}
      ${If} $alLeftText == ""
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "已移除" "$alRmText"
      ${Else}
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "未移除" "$alLeftText。可能正被其他程序占用，关闭后可手动处理。"
      ${EndIf}
      !insertmacro AL_RPATH $mui.FinishPage 42 104 208 "仍在" "$alDataRoot"
      !insertmacro AL_TUCK
      ${If} $alDataEx == 1
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "$alDataSize，没有改动"
      ${Else}
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "这个文件夹不存在，没有改动"
      ${EndIf}
      ${If} $alMode >= 3
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "之后" "重装后自动接上；要彻底删除请手动删。"
      ${Else}
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "之后" "重新安装后自动接上；要彻底删除，可手动删除这个文件夹。"
      ${EndIf}
      ${If} $alDD != ""
        !insertmacro AL_RPATH $mui.FinishPage 42 104 208 "数据目录" "$alDD"
        !insertmacro AL_TUCK
        ${If} $alMode >= 3
          !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "没有改动；重装后同样会接上。"
        ${ElseIf} $alDDSrc == "env"
          !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "没有改动；由环境变量 ALIGHT_DATA_DIR 指定，重新安装后仍使用它。"
        ${Else}
          !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "" "没有改动；位置记在上面的数据文件夹里，重新安装后同样会接上。"
        ${EndIf}
      ${ElseIf} $alDDHint == 1
        !insertmacro AL_RTXT $mui.FinishPage 42 104 208 "数据目录" "数据目录已改到别处，没有改动。"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  ; the keep / drop page: title, paper, her line, the "open the data folder" box (keep only)
  Function un.alRcpPage
    StrCpy $2 0 ; 1 = the data box is shown
    ${If} $alDrop == 1
      SendMessage $mui.FinishPage.Title ${WM_SETTEXT} 0 "STR:已卸载，数据已删除"
      StrCpy $5 "好，放下了。慢走。"
      ShowWindow $mui.FinishPage.ShowReadme ${SW_HIDE}
    ${Else}
      SendMessage $mui.FinishPage.Title ${WM_SETTEXT} 0 "STR:已卸载"
      StrCpy $5 "好，慢走。"
      ${If} $alDataEx == 1
        StrCpy $2 1
      ${Else}
        ShowWindow $mui.FinishPage.ShowReadme ${SW_HIDE}
      ${EndIf}
    ${EndIf}

    ; her line: its box height ($8), with the 14 DIP above it the room it takes under the paper ($6)
    StrCpy $alA $5
    StrCpy $alB $alF13
    StrCpy $alC 286
    Call un.alTextH
    IntOp $8 $alR + 4
    IntOp $6 $8 + 14
    ${If} $2 = 1
      StrCpy $7 364 ; the data box is anchored at 368
    ${Else}
      StrCpy $7 392 ; the credits at 396
    ${EndIf}
    IntOp $7 $7 - $6

    ; tiers 0..2 tighten fonts and paths; tier 3 also says the long rows shorter (a long custom data folder, an
    ; env-var one). If even that does not leave room for her line, her line is left out ($9 = 1): the receipt and
    ; the box are what the page is for, and nothing may overlap.
    StrCpy $alTier 0
    StrCpy $9 0
    ${Do}
      StrCpy $alA $alTier
      Call un.alSetMode
      StrCpy $alDry 1
      StrCpy $3 152
      Call un.alRcpRows
      IntOp $R0 $3 - $alGap
      IntOp $R0 $R0 + 8 ; the paper's bottom edge
      ${If} $R0 <= $7
        ${ExitDo}
      ${EndIf}
      ${If} $alTier >= 3
        StrCpy $9 1
        ${ExitDo}
      ${EndIf}
      IntOp $alTier $alTier + 1
    ${Loop}
    StrCpy $alDry 0

    IntOp $alH $R0 - 142
    !insertmacro AL_LBL $alPaper $mui.FinishPage 28 142 296 $alH ${AL_SS_FILL} "" "${AL_PAPER}" "${AL_PAPER}" ""
    StrCpy $3 152
    Call un.alRcpRows
    IntOp $3 $R0 + 14
    ${If} $9 <> 1
      !insertmacro AL_HER $mui.FinishPage 28 $3 296 $8 "${AL_BG}" "$5"
    ${EndIf}
    ${If} $2 = 1
      !insertmacro AL_CHKDRESS $mui.FinishPage.ShowReadme $mui.FinishPage 28 368 296 20 "${AL_TEXT}" "${AL_BG}" "打开数据文件夹" un.alReadmeChk
    ${EndIf}
  FunctionEnd

  ; The paths that stayed, one label each, from the running y in $3; each path is broken onto lines or (tier 2 and
  ; up) shortened to one line. Tier 3 lists only the first three. $alShownN = how many were listed. With $alDry = 1
  ; it only measures.
  Function un.alFailRows
    Push $0
    Push $1
    Push $2
    Push $4
    StrCpy $0 $alFailList
    StrCpy $2 0
    ${Do}
      ${If} $0 == ""
        ${ExitDo}
      ${EndIf}
      ${If} $alMode >= 3
      ${AndIf} $2 >= 3
        ${ExitDo}
      ${EndIf}
      StrCpy $alA $0
      StrCpy $alB "|"
      Call un.alIndexOf
      ${If} $alR < 0
        ${ExitDo}
      ${EndIf}
      StrCpy $1 $0 $alR
      IntOp $4 $alR + 1
      StrCpy $0 $0 "" $4
      ; (from tier 2 on alPathWrap shortens it: the drive, a "…", as many of the last folders as fit and the last name
      ; in full, so two files in one folder stay apart; the copy button of the page has the full paths)
      StrCpy $alA $1
      StrCpy $alC 270
      Call un.alPathWrap
      IntOp $alH $alN * $alLH
      ${If} $alDry <> 1
        ${If} $alMode = 0
          !insertmacro AL_LBL $4 $mui.FinishPage 42 $3 270 $alH ${AL_SS_ONE} $alFm "${AL_INK}" "${AL_PAPER}" "$alR"
        ${Else}
          !insertmacro AL_LBL $4 $mui.FinishPage 42 $3 270 $alH ${AL_SS_ONE} $alFm10 "${AL_INK}" "${AL_PAPER}" "$alR"
        ${EndIf}
      ${EndIf}
      IntOp $3 $3 + $alH
      IntOp $3 $3 + $alGap
      IntOp $2 $2 + 1
    ${Loop}
    StrCpy $alShownN $2
    Pop $4
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; The inside of the gold-edged paper of the "part of it could not be deleted" page, from y 150: the head line,
  ; the paths, "and N more", what to do. Leaves the bottom edge of the paper in $alH. With $alDry = 1 it only
  ; measures.
  Function un.alFailLayout
    Push $0
    Push $1
    StrCpy $alA "抱歉，有 $alFailCount 项没能删除，可能正被其他程序占用，或路径过长："
    StrCpy $alB $alF11
    StrCpy $alC 250
    Call un.alTextH
    StrCpy $1 $alR
    ${If} $alDry <> 1
      !insertmacro AL_LBL $0 $mui.FinishPage 60 150 250 $1 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" "$alWT"
    ${EndIf}
    IntOp $3 $1 + 158
    Call un.alFailRows
    IntOp $1 $alFailCount - $alShownN
    ${If} $1 > 0
      ${If} $alDry <> 1
        !insertmacro AL_LBL $0 $mui.FinishPage 42 $3 270 16 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" "等 $1 项，都在数据文件夹里。"
      ${EndIf}
      IntOp $3 $3 + 16
      IntOp $3 $3 + $alGap
    ${EndIf}
    ${If} $alLeftText == ""
      ${If} $alCacheState == 1
        StrCpy $alA "关闭占用它们的程序后，可以手动删除。程序文件、更新缓存、快捷方式和其余数据已删除。"
      ${Else}
        StrCpy $alA "关闭占用它们的程序后，可以手动删除。程序文件、快捷方式和其余数据已删除。"
      ${EndIf}
    ${Else}
      StrCpy $alA "没有完全移除：$alLeftText。关闭占用它们的程序后，可以手动删除。"
    ${EndIf}
    StrCpy $alB $alF11
    StrCpy $alC 270
    Call un.alTextH
    StrCpy $1 $alR
    ${If} $alDry <> 1
      !insertmacro AL_LBL $0 $mui.FinishPage 42 $3 270 $1 ${AL_SS_ONE} $alF11 "${AL_INK}" "${AL_PAPER}" "$alWT"
    ${EndIf}
    IntOp $3 $3 + $1
    IntOp $3 $3 + 6
    ; the copy button is always there: one path or many, shortened or not
    ${If} $alFailCount = $alFailShown
      ${If} $alFailCount = 1
        StrCpy $alCopyLbl "复制路径"
      ${Else}
        StrCpy $alCopyLbl "复制全部路径"
      ${EndIf}
    ${Else}
      StrCpy $alCopyLbl "复制前 $alFailShown 项路径"
    ${EndIf}
    !insertmacro AL_COPYROW $mui.FinishPage 42
    IntOp $alH $3 + 2
    Pop $1
    Pop $0
  FunctionEnd

  ; the "part of it could not be deleted" page: the paper, a gold edge, the paths
  Function un.alFailPage
    ${If} $alFailCount >= 1000
      SendMessage $mui.FinishPage.Title ${WM_SETFONT} $alF15b 0
    ${EndIf}
    SendMessage $mui.FinishPage.Title ${WM_SETTEXT} 0 "STR:已卸载，有 $alFailCount 项未删除"
    ShowWindow $mui.FinishPage.ShowReadme ${SW_HIDE}
    StrCpy $alCopy $alFailCopy
    StrCpy $7 380 ; the credits are at 396
    StrCpy $alTier 0
    ${Do}
      StrCpy $alA $alTier
      Call un.alSetMode
      StrCpy $alDry 1
      Call un.alFailLayout
      ${If} $alH <= $7
      ${OrIf} $alTier >= 3
        ${ExitDo}
      ${EndIf}
      IntOp $alTier $alTier + 1
    ${Loop}
    StrCpy $alDry 0
    StrCpy $R0 $alH
    IntOp $alH $R0 - 142
    !insertmacro AL_LBL $alPaper $mui.FinishPage 28 142 296 $alH ${AL_SS_FILL} "" "${AL_PAPER}" "${AL_PAPER}" ""
    !insertmacro AL_LBL $0 $mui.FinishPage 28 142 3 $alH ${AL_SS_FILL} "" "${AL_GOLD_INK}" "${AL_GOLD_INK}" ""
    !insertmacro AL_BMP $0 $mui.FinishPage warn_ink.bmp 42 152 12 12 0
    Call un.alFailLayout
  FunctionEnd

  ; U6 finish
  Function un.alFinishShow
    ${If} $alCacheState == 1
      StrCpy $alRmText "程序文件、更新缓存，以及桌面和开始菜单的快捷方式"
    ${Else}
      StrCpy $alRmText "程序文件，以及桌面和开始菜单的快捷方式"
    ${EndIf}
    ShowWindow $mui.Branding.Text ${SW_SHOW}
    ShowWindow $mui.FinishPage.Text ${SW_HIDE}
    !insertmacro AL_POS $mui.FinishPage.Image 0 0 720 432
    !insertmacro AL_BOTTOM $mui.FinishPage.Image
    ${If} $alDrop == 1
      !insertmacro AL_IMG $mui.FinishPage.Image un_done_drop.bmp
    ${Else}
      !insertmacro AL_IMG $mui.FinishPage.Image un_done_keep.bmp
    ${EndIf}
    !insertmacro AL_POS $mui.FinishPage.Title 28 100 296 30
    SendMessage $mui.FinishPage.Title ${WM_SETFONT} $alF20b 0
    SetCtlColors $mui.FinishPage.Title "${AL_TITLE}" "${AL_BG}"
    ${If} $alFailCount > 0
      Call un.alFailPage
    ${Else}
      Call un.alRcpPage
    ${EndIf}
    !insertmacro AL_CRED $mui.FinishPage 28 396 "${AL_BG}" "${AL_C_FACE}"
    !insertmacro AL_CRED $mui.FinishPage 28 410 "${AL_BG}" "${AL_C_AI}"
    !insertmacro AL_BAR "" "完成" 96 ""
    StrCpy $alA 0
    Call un.alSetMode
  FunctionEnd
!macroend
