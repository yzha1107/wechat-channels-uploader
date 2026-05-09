Put offline/runtime installers in this folder before sending the package.

Required for clean Windows PCs:

1. Node.js 18+ x64 MSI
   Supported names:
   - node-v20.x.x-x64.msi
   - node-v22.x.x-x64.msi

2. Google Chrome installer
   Supported names:
   - GoogleChromeStandaloneEnterprise64.msi
   - ChromeSetup.exe
   - ChromeStandaloneSetup64.exe
   - GoogleChromeStandaloneEnterprise64.exe

3. FFmpeg zip
   Supported names:
   - ffmpeg*.zip
   Example:
   - ffmpeg-release-essentials.zip

start.bat will detect missing Node.js, Chrome, or FFmpeg and install/extract from this folder first.

No-admin portable option:

- Node.js: put node.exe in runtime\nodejs\node.exe or nodejs\node.exe
- Chrome: put chrome.exe in runtime\chrome\chrome.exe, chrome\chrome.exe, or chrome-win64\chrome.exe
Portable folders are checked before system-installed software.
