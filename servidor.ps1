# Servidor local do Estúdio de Vídeos IA.
# Serve os arquivos desta pasta em http://localhost:8765 e abre o navegador.
$ErrorActionPreference = 'Stop'
$porta = 8765
$raiz = Split-Path -Parent $MyInvocation.MyCommand.Path
$prefixo = "http://localhost:$porta/"

$tipos = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefixo)
try {
  $listener.Start()
} catch {
  Write-Host "Nao consegui abrir a porta $porta. Talvez o app ja esteja aberto em outra janela." -ForegroundColor Red
  Start-Process $prefixo
  Read-Host 'Pressione Enter para fechar'
  exit 1
}

Write-Host "Estudio de Videos IA rodando em $prefixo" -ForegroundColor Green
Write-Host 'Deixe esta janela aberta enquanto usa o app. Feche-a para desligar.'
Start-Process $prefixo

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $caminho = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
  if ([string]::IsNullOrEmpty($caminho)) { $caminho = 'index.html' }
  $arquivo = [IO.Path]::GetFullPath((Join-Path $raiz $caminho))
  $resp = $ctx.Response
  if ($arquivo.StartsWith($raiz) -and (Test-Path $arquivo -PathType Leaf)) {
    $ext = [IO.Path]::GetExtension($arquivo).ToLower()
    $resp.ContentType = if ($tipos.ContainsKey($ext)) { $tipos[$ext] } else { 'application/octet-stream' }
    $resp.Headers.Add('Cache-Control', 'no-store')
    $bytes = [IO.File]::ReadAllBytes($arquivo)
    $resp.ContentLength64 = $bytes.Length
    $resp.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $resp.StatusCode = 404
  }
  $resp.OutputStream.Close()
}
