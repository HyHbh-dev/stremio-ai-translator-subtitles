#!/bin/bash
# 双击运行这个文件即可启动。首次运行会自动补上执行权限、解除隔离、做 ad-hoc 签名。
cd "$(dirname "$0")" || exit 1

ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
  BIN="./stremio-ai-subtitles-macos-x64"
else
  BIN="./stremio-ai-subtitles-macos-arm64"
fi

if [ ! -f "$BIN" ]; then
  echo "找不到可执行文件：$BIN"
  echo "请确认解压后所有文件都在同一个文件夹里。"
  read -r -p "按回车键关闭..." _
  exit 1
fi

echo "正在准备 $BIN ..."
chmod +x "$BIN" 2>/dev/null
xattr -d com.apple.quarantine "$BIN" 2>/dev/null
codesign --force --sign - "$BIN" 2>/dev/null

echo "启动中，浏览器会自动打开配置页。关闭这个窗口即停止服务。"
echo
"$BIN"
