# Optional: download three.js and the hand models once so EMG Hand works with no internet
# (useful for a demo in a lecture hall with bad Wi-Fi). Run:
#   powershell -ExecutionPolicy Bypass -File download-assets.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$three = 'https://cdn.jsdelivr.net/npm/three@0.160.0'
$hands = 'https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand'

$files = @{
  "$three/build/three.module.js"                          = 'vendor/three/build/three.module.js'
  "$three/examples/jsm/loaders/GLTFLoader.js"             = 'vendor/three/examples/jsm/loaders/GLTFLoader.js'
  "$three/examples/jsm/utils/BufferGeometryUtils.js"      = 'vendor/three/examples/jsm/utils/BufferGeometryUtils.js'
  "$three/examples/jsm/controls/OrbitControls.js"         = 'vendor/three/examples/jsm/controls/OrbitControls.js'
  "$three/examples/jsm/environments/RoomEnvironment.js"   = 'vendor/three/examples/jsm/environments/RoomEnvironment.js'
  "$hands/right.glb"                                      = 'assets/right.glb'
  "$hands/left.glb"                                       = 'assets/left.glb'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
foreach ($url in $files.Keys) {
  $dest = Join-Path $root $files[$url]
  New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
  Write-Host "Downloading $($files[$url])"
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}
Write-Host "Done - EMG Hand will now run offline." -ForegroundColor Green
