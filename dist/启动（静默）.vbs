' Start the addon without a console window.
' Double-click this file instead of the .exe if you do not want a black window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
exePath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "stremio-ai-subtitles.exe")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run """" & exePath & """", 0, False
