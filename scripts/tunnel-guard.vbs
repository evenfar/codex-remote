' tunnel-guard.vbs — Windows 端 SSH 反向隧道守护（无窗口后台运行）
' 作用：把本机 Clash 代理端口 127.0.0.1:7897 反向转发给服务器，
'       让服务器上的 codex 能借道本机梯子出海。
' 用法：双击运行，或在 tunnnel-guard.bat 里配置参数后启动。
' 依赖：Windows 自带 OpenSSH 客户端（C:\Windows\System32\OpenSSH\ssh.exe）
Dim shell, fso, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' ===== 按需修改这三行 =====
SERVER = "user@your-server.com"       ' 服务器 SSH 地址
SERVER_PORT = "22"                     ' SSH 端口
LOCAL_PROXY_PORT = "7897"              ' 本机梯子的混合代理端口（Clash Verge 默认 7897）
' =========================

cmd = "cmd /c title codex-tunnel & " & _
  ":loop & " & _
  "echo [%date% %time%] (re)connecting tunnel... & " & _
  "ssh -N -R 7890:127.0.0.1:" & LOCAL_PROXY_PORT & _
  " -p " & SERVER_PORT & _
  " -o ServerAliveInterval=30 -o ServerAliveCountMax=3" & _
  " -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=accept-new" & _
  " " & SERVER & " & " & _
  "echo [%date% %time%] tunnel dropped, retry in 5s & timeout /t 5 /nobreak >nul & goto loop"

shell.Run cmd, 0, False
