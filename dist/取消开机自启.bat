@echo off
chcp 65001 >nul
setlocal
echo 正在取消开机自动启动...
schtasks /delete /tn "StremioAISubtitles" /f
if %errorlevel%==0 (
  echo.
  echo 已取消。
) else (
  echo.
  echo 没有找到开机自启任务，可能之前没设置过。
)
echo.
pause
