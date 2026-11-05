' Abre el Centro de Directos sin ventana (en segundo plano).
Set fso = CreateObject("Scripting.FileSystemObject")
carpeta = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = carpeta
sh.Run "cmd /c """ & carpeta & "\iniciar-centro.bat""", 0, False
