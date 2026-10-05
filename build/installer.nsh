; Included by electron-builder's NSIS installer (electron-builder.yml nsis.include).
;
; Grant ALL APPLICATION PACKAGES (S-1-15-2-1) read access to the install folder.
;
; Since Electron 44.5.0 (electron/electron#54484, the backport of #54382 for
; issue #51761), the browser process checks, before it starts any child
; process, that the sandbox's restricted token can read icudtl.dat. When the
; install folder's ACL carries an AppContainer package entry (S-1-15-2-*) but
; no ALL APPLICATION PACKAGES grant, startup aborts with a FATAL in the log.
; The check is unconditional: --no-sandbox, --disable-gpu-sandbox and
; --in-process-gpu do not get past it. Program Files inherits the grant, so
; Chrome never hits this. A per-user install under %LOCALAPPDATA%\Programs,
; which is where this oneClick, perMachine: false installer puts Kangentic,
; does not. Those machines were already broken on Electron 41, as a GPU crash
; loop ending in "GPU process isn't usable. Goodbye."
;
; customInstall runs on every install AND every auto-update: electron-updater
; re-runs this installer with --updated, and the update deletes and recreates
; $INSTDIR, which drops any ACL set on it before. So the grant has to run each
; time, not once.
;
; The (OI)(CI) inheritance flags reach the files already extracted, because
; icacls propagates an inheritable entry to existing children.
;
; A failure is logged and the install carries on: a missing grant only matters
; on machines with the stray AppContainer entry, and aborting a oneClick
; install would break every machine instead.
;
; Delete this file (and nsis.include) once electron-builder ships the same
; grant itself: electron-userland/electron-builder#10242.
; tests/unit/nsis-acl-grant.test.ts fails when it does.

!macro customInstall
  ${if} $installMode == "CurrentUser"
    Push $0
    nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX)'
    Pop $0
    ${if} $0 != "0"
      DetailPrint "Could not grant ALL APPLICATION PACKAGES read access to $INSTDIR (icacls returned $0)"
    ${endif}
    Pop $0
  ${endif}
!macroend
