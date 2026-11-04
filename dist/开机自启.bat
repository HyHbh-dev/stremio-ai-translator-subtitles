@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo 正在设置开机自动启动...
schtasks /create /tn "StremioAISubtitles" /tr "wscript.exe \"%~dp0启动（静默）.vbs\"" /sc onlogon /rl highest /f
if %errorlevel%==0 (
  echo.
  echo 设置成功。下次登录 Windows 会自动在后台启动，不弹窗口。
) else (
  echo.
  echo 设置失败，请右键本文件选择「以管理员身份运行」再试一次。
)
echo.
pause
