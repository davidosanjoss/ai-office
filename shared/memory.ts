// ai-memory (memória dos agentes): versão fixa e o passo a passo do Windows. Usado pelo
// servidor e pela interface.

/** Versão fixa: o ai-memory muda rápido e as migrações do banco só andam para frente. Atualize de propósito. */
export const MEMORY_VERSION = '3.2.8';
export const MEMORY_IMAGE = `docker.io/akitaonrails/ai-memory:${MEMORY_VERSION}`;
export const MEMORY_RELEASE = `https://github.com/akitaonrails/ai-memory/releases/download/v${MEMORY_VERSION}`;
export const MEMORY_CONTAINER = 'ai-memory';
export const MEMORY_PORT = 49374;

/**
 * Windows com Docker Desktop ("Scenario B" do docs/windows.md do ai-memory), na versão fixa.
 * O escritório ainda não roda isso sozinho: mostra para você colar no PowerShell.
 */
export function windowsSteps(version = MEMORY_VERSION): string {
  const release = `https://github.com/akitaonrails/ai-memory/releases/download/v${version}`;
  return `# 1. O comando ai-memory (wrapper do Docker), conferido pelo checksum
$UserBin = "$HOME\\bin"
New-Item -ItemType Directory -Force $UserBin | Out-Null
foreach ($Pair in @(@("ai-memory.ps1", "ai-memory-wrapper.ps1"), @("ai-memory.cmd", "ai-memory-wrapper.cmd"))) {
    $File = $Pair[0]; $Asset = $Pair[1]
    Invoke-WebRequest -Uri "${release}/$Asset" -OutFile "$UserBin\\$File"
    Invoke-WebRequest -Uri "${release}/$Asset.sha256" -OutFile "$UserBin\\$File.sha256"
    $Expected = ((Get-Content "$UserBin\\$File.sha256" -Raw) -split '\\s+')[0]
    $Actual = (Get-FileHash "$UserBin\\$File" -Algorithm SHA256).Hash.ToLower()
    if ($Actual -ne $Expected.ToLower()) { throw "Checksum errado em $Asset" }
    Remove-Item "$UserBin\\$File.sha256"
}
Get-ChildItem "$UserBin\\ai-memory.*" | Unblock-File
$env:Path = "$env:Path;$UserBin"

# 2. O servidor no Docker Desktop, só para esta máquina
docker run -d --name ai-memory --restart unless-stopped \`
    -p 127.0.0.1:49374:49374 -v ai-memory-data:/data \`
    docker.io/akitaonrails/ai-memory:${version}

# 3. Ligar ao Claude Code (vale para todas as sessões do Claude no Windows)
$env:AI_MEMORY_IMAGE = "docker.io/akitaonrails/ai-memory:${version}"
ai-memory install-mcp   --client claude-code --apply
ai-memory install-hooks --agent  claude-code --apply`;
}
