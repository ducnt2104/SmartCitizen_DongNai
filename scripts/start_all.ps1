$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "=== SmartCitizen Dong Nai - Khoi dong Full Local-First Stack ===" -ForegroundColor Cyan

# 1. Dam bao Rust CV Engine da build release va khoi tao model ONNX cuc bo
if (-not (Test-Path "engine\target\release\smartcitizen-cv-engine.exe")) {
    & "$PSScriptRoot\download_models.ps1"
}

# 2. Kiem tra Ollama (neu co cai dat tren may)
if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Write-Host "[ollama] Phat hien Ollama tren may - dam bao dich vu dang chay tai :11434" -ForegroundColor Green
} else {
    Write-Host "[ollama] Chua cai Ollama - Chatbot se tu dong dung Local BM25 RAG sieu toc (<3ms)" -ForegroundColor Yellow
}

# 3. Khoi chay song song Backend (:8080, tu dong spawn Rust CV Engine :8001) va Frontend (:5173)
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$RepoRoot'; npm run dev:backend"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$RepoRoot'; npm run dev:frontend"

Write-Host "Da mo 2 cua so dich vu: Backend (http://localhost:8080 + Rust CV :8001) va Frontend (http://localhost:5173)" -ForegroundColor Green
