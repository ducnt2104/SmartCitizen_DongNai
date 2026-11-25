param(
    [switch]$DownloadExternal
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ModelsDir = Join-Path $RepoRoot 'models'
New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

Write-Host "[models] Thu muc luu model ONNX cuc bo: $ModelsDir" -ForegroundColor Cyan

# 1. Khoi tao ngay model ONNX cuc bo `authenticity_defect_v1.onnx` bang Rust CV Engine (chay offline 100%)
$EngineDir = Join-Path $RepoRoot 'engine'
if (Get-Command cargo -ErrorAction SilentlyContinue) {
    Write-Host "[models] Dang bien dich Rust CV Engine (release) va khoi tao model ONNX cuc bo..." -ForegroundColor Yellow
    Push-Location $EngineDir
    try {
        cargo build --release
    } finally {
        Pop-Location
    }
    Write-Host "[models] Da san sang binary release: engine/target/release/smartcitizen-cv-engine.exe" -ForegroundColor Green
}

# 2. Tuy chon tai them trong so YOLOv8n / MobileCLIP ONNX tu HuggingFace khi truyen co -DownloadExternal
if ($DownloadExternal) {
    $ExternalModels = @(
        @{
            Name = 'yolov8n.onnx'
            Url  = 'https://huggingface.co/SpotLab/YOLOv8Detection/resolve/main/yolov8n.onnx'
        }
    )
    foreach ($m in $ExternalModels) {
        $Dest = Join-Path $ModelsDir $m.Name
        if (-not (Test-Path $Dest)) {
            Write-Host "[models] Dang tai $($m.Name) tu $($m.Url)..." -ForegroundColor Yellow
            Invoke-WebRequest -Uri $m.Url -OutFile $Dest -UseBasicParsing
            Write-Host "[models] Da luu $Dest" -ForegroundColor Green
        } else {
            Write-Host "[models] Da ton tai $Dest, bo qua." -ForegroundColor Gray
        }
    }
} else {
    Write-Host "[models] Meo: Truyen -DownloadExternal neu muon tai them yolov8n.onnx (~12MB) tu HuggingFace." -ForegroundColor Gray
}
