# Android 模拟器一键配置（Windows 优先）
# 功能：检查/安装 JDK 21 -> 下载 SDK 命令行工具 -> 安装 platform-tools / emulator / 平台包 / 系统镜像
#       -> 设置环境变量 -> 创建 AVD -> （可选）启动模拟器
# 可重复运行：已装好的组件会跳过。

param(
    [string]$SdkRoot = "$env:LOCALAPPDATA\Android\Sdk",
    [string]$AvdName = "base_x86",
    [string]$ApiLevel = "34",
    [switch]$Launch
)

$ErrorActionPreference = "Stop"
$CmdlineToolsVersion = "11076708"   # Google 发布的命令行工具版本号，若下载 404 请到 developer.android.com/studio#command-tools 查最新号
$Target = "google_apis"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!]  $msg" -ForegroundColor Yellow }

# ---------- 0. 系统检查 ----------
Write-Step "检查系统"
if ($env:OS -ne "Windows_NT") { throw "此脚本仅适用于 Windows。macOS/Linux 请另行处理。" }
$arch = $env:PROCESSOR_ARCHITECTURE
# ARM64 Windows 使用 arm64-v8a 镜像，其余使用 x86_64（需要 Hypervisor 加速）
$abi = if ($arch -eq "ARM64") { "arm64-v8a" } else { "x86_64" }
Write-Ok "架构 $arch -> 系统镜像 ABI: $abi"

# 虚拟化检查（只提示，不强制）
try {
    $hv = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent
    if ($hv) { Write-Ok "Hypervisor 已启用（可加速模拟器）" }
    else { Write-Warn "未检测到 Hypervisor。请在 BIOS 开启 VT-x/AMD-V，并在“启用或关闭 Windows 功能”中勾选“虚拟机平台”和“Windows 虚拟机监控程序平台”，然后重启。" }
} catch { Write-Warn "无法检测虚拟化状态，跳过。" }

# ---------- 1. JDK 21 ----------
Write-Step "检查 Java 21"
$javaOk = $false
try {
    $verText = (& java -version 2>&1 | Out-String)
    if ($verText -match 'version "(\d+)') { $javaOk = ([int]$Matches[1] -ge 17) }
} catch { $javaOk = $false }

if (-not $javaOk) {
    Write-Warn "未找到 Java 17+，通过 winget 安装 Microsoft OpenJDK 21..."
    winget install --id Microsoft.OpenJDK.21 -e --accept-source-agreements --accept-package-agreements
    $env:JAVA_HOME = (Get-ChildItem "C:\Program Files\Microsoft" -Directory -Filter "jdk-21*" | Select-Object -First 1).FullName
    $env:Path = "$env:JAVA_HOME\bin;$env:Path"
}
Write-Ok ("Java: " + ((& java -version 2>&1 | Select-Object -First 1)))

# 把 JAVA_HOME 写进用户环境变量（若未设置）
if (-not [Environment]::GetEnvironmentVariable("JAVA_HOME", "User") -and $env:JAVA_HOME) {
    [Environment]::SetEnvironmentVariable("JAVA_HOME", $env:JAVA_HOME, "User")
}

# ---------- 2. SDK 命令行工具 ----------
Write-Step "准备 Android SDK 命令行工具"
$latest = Join-Path $SdkRoot "cmdline-tools\latest"
$sdkmanager = Join-Path $latest "bin\sdkmanager.bat"
if (-not (Test-Path $sdkmanager)) {
    $zip = Join-Path $env:TEMP "cmdline-tools.zip"
    $url = "https://dl.google.com/android/repository/commandlinetools-win-$CmdlineToolsVersion`_latest.zip"
    Write-Host "    下载 $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $tmp = Join-Path $env:TEMP "cmdline-tools-extract"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path (Split-Path $latest) | Out-Null
    if (Test-Path $latest) { Remove-Item $latest -Recurse -Force }
    Move-Item (Join-Path $tmp "cmdline-tools") $latest
    Remove-Item $zip -Force; Remove-Item $tmp -Recurse -Force
    Write-Ok "命令行工具已安装到 $latest"
} else { Write-Ok "命令行工具已存在" }

$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$env:Path = "$latest\bin;$SdkRoot\platform-tools;$SdkRoot\emulator;$env:Path"

# ---------- 3. 接受许可 + 安装组件 ----------
Write-Step "安装 SDK 组件（首次较大，需要一段时间）"
$yes = ("y`n" * 50)
$yes | & $sdkmanager --licenses | Out-Null

$packages = @(
    "platform-tools",
    "emulator",
    "platforms;android-$ApiLevel",
    "system-images;android-$ApiLevel;$Target;$abi"
)
& $sdkmanager --install $packages
if ($LASTEXITCODE -ne 0) { throw "sdkmanager 安装失败，请检查网络后重新运行脚本。" }
Write-Ok "组件安装完成"

# ---------- 4. 环境变量（用户级，永久生效） ----------
Write-Step "写入用户环境变量"
[Environment]::SetEnvironmentVariable("ANDROID_HOME", $SdkRoot, "User")
[Environment]::SetEnvironmentVariable("ANDROID_SDK_ROOT", $SdkRoot, "User")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$addPaths = @("$latest\bin", "$SdkRoot\platform-tools", "$SdkRoot\emulator")
foreach ($p in $addPaths) {
    if ($userPath -notlike "*$p*") { $userPath = "$userPath;$p" }
}
[Environment]::SetEnvironmentVariable("Path", $userPath, "User")
Write-Ok "ANDROID_HOME / PATH 已写入（新开终端生效）"

# ---------- 5. 创建 AVD ----------
Write-Step "创建 AVD: $AvdName"
$avdmanager = Join-Path $latest "bin\avdmanager.bat"
$existing = (& (Join-Path $SdkRoot "emulator\emulator.exe") -list-avds 2>$null)
if ($existing -contains $AvdName) {
    Write-Ok "AVD 已存在，跳过"
} else {
    $sysImg = "system-images;android-$ApiLevel;$Target;$abi"
    "no" | & $avdmanager create avd -n $AvdName -k $sysImg -d pixel_6 --force
    if ($LASTEXITCODE -ne 0) { throw "创建 AVD 失败。" }
    Write-Ok "AVD 已创建"
}

# ---------- 6. 完成 ----------
Write-Step "完成"
Write-Host "    启动模拟器： emulator -avd $AvdName"
Write-Host "    检查设备：   adb devices"
Write-Host "    提示：首次运行请新开终端，让 PATH 生效。"

if ($Launch) {
    Write-Step "启动模拟器"
    Start-Process -FilePath (Join-Path $SdkRoot "emulator\emulator.exe") -ArgumentList "-avd", $AvdName
}
