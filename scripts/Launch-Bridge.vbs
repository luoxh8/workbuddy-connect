' Launch-Bridge.vbs
' Hidden launcher for the WorkBuddy bridge Scheduled Task action.
'
' Why this file exists: Task Scheduler starts a console program (powershell.exe,
' node.exe) in the user's interactive session, and Windows creates a console
' window for it before the program can hide anything — that is the black window
' that used to flash at logon. wscript.exe is a GUI-subsystem host, so starting
' the task through it allocates no console at all; Shell.Run with window style 0
' then creates the PowerShell supervisor (and its node child) hidden.
'
' Arguments (paths are passed separately so no nested quoting is needed):
'   1  bridge state directory
'   2  bridge port
'   3  node.exe path
'
' Run-Bridge.ps1 is located next to this script, so moving the checkout around
' needs no argument change.
'
' The wait flag is True on purpose: wscript stays alive for as long as the
' supervisor runs, so the Scheduled Task stays "Running" and its restart
' settings keep working, exactly as they did when the action was powershell.exe.

Option Explicit

Dim shell, fso, command, exitCode
Dim scriptDir, runScript, stateDir, port, nodePath

If WScript.Arguments.Count < 3 Then
    WScript.Quit 2
End If

stateDir = WScript.Arguments(0)
port = WScript.Arguments(1)
nodePath = WScript.Arguments(2)

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
runScript = fso.BuildPath(scriptDir, "Run-Bridge.ps1")

If Not fso.FileExists(runScript) Then
    WScript.Quit 3
End If

command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden" _
    & " -ExecutionPolicy Bypass -File " & Quote(runScript) _
    & " -StateDir " & Quote(stateDir) _
    & " -Port " & port _
    & " -NodePath " & Quote(nodePath)

Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
    Quote = """" & value & """"
End Function
