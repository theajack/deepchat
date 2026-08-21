#!/usr/bin/env python3
"""
根据用户提供的 source.png 生成所有平台的应用图标。
源图 512x512（带圆角边框），输出：
  - 根级 PNG（icon.png/32/64/128/128@2x + Windows Square*Logo + StoreLogo）
  - iOS AppIcon-{size}@{scale}.png
  - Android mipmap-{dpi}/ic_launcher*.png
  - icon.ico（多尺寸 Windows ICO）
  - 用 iconutil 生成 icon.icns（前置：set/icon_*.png）
"""
import os
import shutil
from pathlib import Path
from PIL import Image

ICON_DIR = Path("/Users/tackchen/code/ai/chat-agent/app/src-tauri/icons")
SRC = ICON_DIR / "source.png"
ICNSET = ICON_DIR / "set"

img = Image.open(SRC).convert("RGBA")


def save(name: str, size: int, fit: bool = True):
    """等比缩放后居中写入到指定尺寸（保持原比例，多余处透明）。"""
    if fit:
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        resized = img.resize((size, size), Image.LANCZOS)
        canvas.paste(resized, (0, 0), resized)
        canvas.save(ICON_DIR / name, "PNG")
    else:
        img.resize((size, size), Image.LANCZOS).save(ICON_DIR / name, "PNG")


# --- 1. 根级 PNG（mac/win/linux 通用）---
root_sizes = {
    "icon.png": 512,
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    # Windows Store / MSIX 标准
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}
for name, size in root_sizes.items():
    save(name, size)
print(f"[root] {len(root_sizes)} PNG")

# --- 2. iOS AppIcon ---
ios_sizes = {
    "AppIcon-20x20@1x.png": 20,
    "AppIcon-20x20@2x.png": 40,
    "AppIcon-20x20@2x-1.png": 40,
    "AppIcon-20x20@3x.png": 60,
    "AppIcon-29x29@1x.png": 29,
    "AppIcon-29x29@2x.png": 58,
    "AppIcon-29x29@2x-1.png": 58,
    "AppIcon-29x29@3x.png": 87,
    "AppIcon-40x40@1x.png": 40,
    "AppIcon-40x40@2x.png": 80,
    "AppIcon-40x40@2x-1.png": 80,
    "AppIcon-40x40@3x.png": 120,
    "AppIcon-60x60@2x.png": 120,
    "AppIcon-60x60@3x.png": 180,
    "AppIcon-76x76@1x.png": 76,
    "AppIcon-76x76@2x.png": 152,
    "AppIcon-83.5x83.5@2x.png": 167,
    "AppIcon-512@2x.png": 1024,
}
ios_dir = ICON_DIR / "ios"
ios_dir.mkdir(exist_ok=True)
for name, size in ios_sizes.items():
    save(f"ios/{name}", size)
print(f"[ios] {len(ios_sizes)} PNG")

# --- 3. Android mipmap-* ---
android_dp = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for dpi, size in android_dp.items():
    d = ICON_DIR / "android" / f"mipmap-{dpi}"
    d.mkdir(parents=True, exist_ok=True)
    for name in ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]:
        save(f"android/mipmap-{dpi}/{name}", size)
print(f"[android] {len(android_dp) * 3} PNG")

# --- 4. .ico（Windows 多尺寸）---
ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save(ICON_DIR / "icon.ico", format="ICO", sizes=ico_sizes)
print(f"[ico] {len(ico_sizes)} sizes")

# --- 5. .icns 前置：输出 macOS iconset 各种尺寸 ---
icns_sizes = {
    "icon_16x16.png": 16,
    "icon_16x16@2x.png": 32,
    "icon_32x32.png": 32,
    "icon_32x32@2x.png": 64,
    "icon_128x128.png": 128,
    "icon_128x128@2x.png": 256,
    "icon_256x256.png": 256,
    "icon_256x256@2x.png": 512,
    "icon_512x512.png": 512,
    "icon_512x512@2x.png": 1024,
}
for name, size in icns_sizes.items():
    img.resize((size, size), Image.LANCZOS).save(ICNSET / name, "PNG")
print(f"[icns-set] {len(icns_sizes)} PNG")
print("done")
