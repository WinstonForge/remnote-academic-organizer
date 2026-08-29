' Launches the Academic Organizer static plugin server with no console window.
' Register it to run at logon with:
'   schtasks /Create /SC ONLOGON /TN "RemNote Academic Organizer" ^
'     /TR "wscript.exe \"C:\AI\RemNote-Organizer\start-hidden.vbs\""
' Remove it with:
'   schtasks /Delete /TN "RemNote Academic Organizer" /F
Dim shell
Set shell = CreateObject("Wscript.Shell")
shell.CurrentDirectory = "C:\AI\RemNote-Organizer"
shell.Run "node ""C:\AI\RemNote-Organizer\serve-plugin.js""", 0, False
