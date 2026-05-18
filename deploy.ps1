# deploy.ps1 - valida local, exige git limpo, faz push e reinicia o servidor
#
# ANTES DO PRIMEIRO DEPLOY:
#  1. Crie um repositório git REMOTO próprio (separado do bot-barbeiro) e rode:
#       git remote add origin <url-do-repo-lash>
#       git push -u origin main
#  2. Roda na MESMA VM do bot-barbeiro, mas isolado: pasta, PM2 e portas
#     próprios (Express 3003, WAHA 3011, nginx 8444). Não sobrescreve o barbeiro.

$KEY = "D:\Downloads\myVm_key.pem"
$SSH_USER = "jota_azure"
$SSH_HOST = "68.211.112.120"
$REMOTE_PATH = "/home/jota_azure/bot-lash-designer"
$PM2_APP = "bot-lash-designer"

Write-Host "==> [1/5] Conferindo git..." -ForegroundColor Cyan
$changes = git status --porcelain
if ($changes) {
    Write-Host ""
    Write-Host "ERRO: Existem mudancas locais nao commitadas." -ForegroundColor Red
    Write-Host "Para evitar deploy acidental, este script nao faz git add/commit automatico." -ForegroundColor Yellow
    Write-Host ""
    git status --short
    Write-Host ""
    Write-Host "Faca um commit seletivo do que quer publicar e rode o deploy novamente." -ForegroundColor Yellow
    exit 1
}

Write-Host "==> [2/5] Rodando testes..." -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERRO: Testes falharam. Deploy abortado." -ForegroundColor Red
    exit 1
}

Write-Host "==> [3/5] Compilando TypeScript..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERRO: Build falhou. Deploy abortado." -ForegroundColor Red
    exit 1
}

Write-Host "==> [4/5] Fazendo push para o git..." -ForegroundColor Cyan
git push
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERRO: Push falhou. Deploy abortado." -ForegroundColor Red
    exit 1
}

Write-Host "==> [5/5] Atualizando e reiniciando no servidor..." -ForegroundColor Cyan
ssh -i $KEY "${SSH_USER}@${SSH_HOST}" "cd ${REMOTE_PATH} && git pull --ff-only && npm ci && npm run build && pm2 restart ${PM2_APP} --update-env && pm2 status"
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERRO: Deploy no servidor falhou." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Deploy concluido com sucesso!" -ForegroundColor Green
