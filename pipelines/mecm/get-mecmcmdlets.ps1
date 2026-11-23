<#
.SYNOPSIS
    Extracts MECM/SCCM PowerShell cmdlet data from the installed ConfigurationManager module.

.DESCRIPTION
    Imports the ConfigurationManager module from the installed MECM site,
    enumerates all cmdlets, and generates JSON data files compatible with MecmIndex.

.PARAMETER OutputPath
    Path to the output directory. Defaults to data\mecm in the repo root.

.PARAMETER ModulePath
    Optional explicit path to the ConfigurationManager module .psd1 file.

.EXAMPLE
    .\get-mecmcmdlets.ps1 -OutputPath .\data\mecm
#>
[CmdletBinding()]
param(
    [Parameter()]
    [string]$OutputPath,

    [Parameter()]
    [string]$ModulePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

#region --- Helpers ---

# Category mapping: noun keyword → category (order matters; first match wins)
$NounCategories = [ordered]@{
    'AppV'                  = 'Application Management'
    'DeploymentType'        = 'Application Management'
    'Application'           = 'Application Management'
    'Package'               = 'Application Management'
    'Script'                = 'Application Management'
    'SoftwareUpdate'        = 'Software Updates'
    'SumRule'               = 'Software Updates'
    'UpdateList'            = 'Software Updates'
    'UpdatePoint'           = 'Software Updates'
    'DeviceCollection'      = 'Collections'
    'UserCollection'        = 'Collections'
    'Collection'            = 'Collections'
    'TaskSequence'          = 'OS Deployment'
    'BootImage'             = 'OS Deployment'
    'Driver'                = 'OS Deployment'
    'OSImage'               = 'OS Deployment'
    'OperatingSystem'       = 'OS Deployment'
    'DistributionPoint'     = 'Content Management'
    'ContentLibrary'        = 'Content Management'
    'Content'               = 'Content Management'
    'Distribution'          = 'Content Management'
    'ManagementPoint'       = 'Site Infrastructure'
    'FallbackStatusPoint'   = 'Site Infrastructure'
    'SiteSystem'            = 'Site Infrastructure'
    'SiteRole'              = 'Site Infrastructure'
    'SiteAddress'           = 'Site Infrastructure'
    'BoundaryGroup'         = 'Site Infrastructure'
    'Boundary'              = 'Site Infrastructure'
    'Migration'             = 'Site Infrastructure'
    'Site'                  = 'Site Infrastructure'
    'ConfigurationItem'     = 'Compliance'
    'ConfigItem'            = 'Compliance'
    'Baseline'              = 'Compliance'
    'CompliancePolicy'      = 'Compliance'
    'ComplianceRule'        = 'Compliance'
    'Remediation'           = 'Compliance'
    'AntiMalware'           = 'Endpoint Protection'
    'MalwarePolicy'         = 'Endpoint Protection'
    'FirewallPolicy'        = 'Endpoint Protection'
    'EndpointProtection'    = 'Endpoint Protection'
    'Defender'              = 'Endpoint Protection'
    'SecurityRole'          = 'Security'
    'SecurityScope'         = 'Security'
    'AdministrativeUser'    = 'Security'
    'Administrator'         = 'Security'
    'Credential'            = 'Security'
    'ClientSetting'         = 'Client Management'
    'ClientStatus'          = 'Client Management'
    'Client'                = 'Client Management'
    'UserDeviceAffinity'    = 'User Management'
    'UserAffinity'          = 'User Management'
    'DeviceAffinity'        = 'User Management'
    'User'                  = 'User Management'
    'ReportingServicePoint' = 'Reporting'
    'Report'                = 'Reporting'
    'Alert'                 = 'Monitoring'
    'StatusMessage'         = 'Monitoring'
    'CMG'                   = 'Cloud Management'
    'CoManagement'          = 'Co-Management'
    'CloudManagement'       = 'Cloud Management'
    'AssetIntelligence'     = 'Asset Intelligence'
    'HardwareInventory'     = 'Inventory'
    'Inventory'             = 'Inventory'
    'Certificate'           = 'Certificates'
    'MDM'                   = 'Mobile Management'
    'Device'                = 'Device Management'
    'Computer'              = 'Device Management'
    'Resource'              = 'Device Management'
    'Query'                 = 'Device Management'
    'Deployment'            = 'Deployment'
}

function Get-CmdletCategory([string]$Noun) {
    # Strip leading 'CM' prefix for matching
    $nounStripped = if ($Noun -match '^CM(.+)$') { $Matches[1] } else { $Noun }
    foreach ($key in $NounCategories.Keys) {
        if ($nounStripped -like "$key*" -or $nounStripped -imatch $key) {
            return $NounCategories[$key]
        }
    }
    return 'General'
}

function Get-CategorySlug([string]$Category) {
    return ($Category -replace '[^A-Za-z0-9]', '')
}

function Get-SiteRole([string]$Text) {
    $lower = $Text.ToLower()
    if ($lower -match 'central administration') { return 'CAS' }
    if ($lower -match 'primary site')           { return 'Primary' }
    if ($lower -match 'secondary site')         { return 'Secondary' }
    if ($lower -match 'sms provider')           { return 'SMS Provider' }
    return ''
}

function ConvertTo-CleanText([string]$Text) {
    if (-not $Text) { return '' }
    # Remove markdown-style links, bold, etc.
    $t = $Text -replace '\r', ' ' -replace '\n', ' '
    $t = $t -replace '\s+', ' '
    return $t.Trim()
}

#endregion

#region --- Locate and Import Module ---

$cmModulePaths = @(
    $ModulePath,
    "$env:SMS_ADMIN_UI_PATH\..\ConfigurationManager.psd1",
    'C:\Program Files (x86)\Microsoft Configuration Manager\AdminConsole\bin\ConfigurationManager.psd1',
    'C:\Program Files\Microsoft Configuration Manager\AdminConsole\bin\ConfigurationManager.psd1',
    "$env:ProgramFiles(x86)\Microsoft Configuration Manager\AdminConsole\bin\ConfigurationManager.psd1"
)

$resolvedPath = $null
foreach ($path in $cmModulePaths) {
    if ($path -and (Test-Path $path)) {
        $resolvedPath = $path
        break
    }
}

if (-not $resolvedPath) {
    # Try finding in module path
    $mod = Get-Module -Name ConfigurationManager -ListAvailable -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($mod) { $resolvedPath = $mod.Path }
}

if (-not $resolvedPath) {
    Write-Error @"
ConfigurationManager module not found.
Install the MECM admin console or specify -ModulePath:
  .\get-mecmcmdlets.ps1 -ModulePath 'C:\path\to\ConfigurationManager.psd1'
"@
    exit 1
}

Write-Host "Importing ConfigurationManager from: $resolvedPath" -ForegroundColor Cyan
try {
    Import-Module $resolvedPath -Force -ErrorAction Stop
} catch {
    Write-Error "Failed to import ConfigurationManager module: $_"
    exit 1
}

#endregion

#region --- Enumerate Cmdlets ---

Write-Host 'Enumerating cmdlets...' -ForegroundColor Cyan
$commands = Get-Command -Module ConfigurationManager -CommandType Cmdlet, Function | Sort-Object Name
Write-Host "Found $($commands.Count) cmdlets" -ForegroundColor Green

#endregion

#region --- Determine Output Path ---

if (-not $OutputPath) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $OutputPath = Join-Path (Split-Path -Parent (Split-Path -Parent $scriptDir)) 'data\mecm'
}

$modulesDir = Join-Path $OutputPath 'modules'
New-Item -ItemType Directory -Force -Path $modulesDir | Out-Null
Write-Host "Output directory: $OutputPath"

#endregion

#region --- Process Cmdlets ---

$manifest    = [System.Collections.Generic.List[hashtable]]::new()
$descriptions = @{}
$moduleData   = @{}  # category slug → cmdlets hashtable

$total = $commands.Count
$i = 0
foreach ($cmd in $commands) {
    $i++
    if ($i % 50 -eq 0) { Write-Progress -Activity 'Processing cmdlets' -Status "$i / $total" -PercentComplete ([int](100 * $i / $total)) }

    $name = $cmd.Name
    if ($name -notmatch '^[A-Za-z]+-CM') { continue }

    $parts = $name -split '-', 2
    $verb  = $parts[0]
    $noun  = if ($parts.Count -gt 1) { $parts[1] } else { $name }

    $category = Get-CmdletCategory $noun
    $slug     = Get-CategorySlug $category

    # Get-Help can be slow; suppress errors
    $help = $null
    try { $help = Get-Help $name -Full -ErrorAction SilentlyContinue } catch {}

    $synopsis    = if ($help.Synopsis)     { ConvertTo-CleanText $help.Synopsis }     else { "$name cmdlet." }
    $description = if ($help.Description) { ConvertTo-CleanText ($help.Description | Out-String) } else { $synopsis }
    $siteRole    = Get-SiteRole ($description + ' ' + $synopsis)

    # Syntax
    $syntaxText = ''
    try {
        $syntaxLines = @($help.Syntax.SyntaxItem | ForEach-Object {
            $paramStr = ($_.Parameter | ForEach-Object {
                $req = $_.required -eq $true
                $pname = "-$($_.Name)"
                $ptype = if ($_.ParameterValue) { " <$($_.ParameterValue)>" } else { '' }
                if (-not $req) { "[$pname$ptype]" } else { "$pname$ptype" }
            }) -join ' '
            "$name $paramStr"
        })
        $syntaxText = $syntaxLines[0]
    } catch {}
    if (-not $syntaxText) { $syntaxText = $name }

    # Examples
    $examples = @()
    try {
        $examples = @($help.Examples.Example | ForEach-Object {
            $code = ($_.Code -replace '\r', '').Trim()
            if ($code) { $code }
        } | Where-Object { $_ })
    } catch {}

    # Parameters
    $parameters = @()
    try {
        $commonParams = 'WhatIf','Confirm','Verbose','Debug','ErrorAction','ErrorVariable','WarningAction','WarningVariable','OutBuffer','PipelineVariable','OutVariable','InformationAction','InformationVariable'
        $parameters = @($cmd.Parameters.Values | Where-Object { $_.Name -notin $commonParams } | ForEach-Object {
            $p = $_
            $paramDesc = ''
            try { $paramDesc = ($help.Parameters.Parameter | Where-Object { $_.Name -eq $p.Name } | Select-Object -First 1).Description | Out-String; $paramDesc = ConvertTo-CleanText $paramDesc } catch {}
            @{
                name        = $p.Name
                type        = $p.ParameterType.Name
                required    = ($p.Attributes | Where-Object { $_ -is [System.Management.Automation.ParameterAttribute] } | Select-Object -First 1 -ExpandProperty Mandatory -ErrorAction SilentlyContinue) -eq $true
                description = $paramDesc
            }
        })
    } catch {}

    $hasExamples = $examples.Count -gt 0

    # Manifest entry
    $manifest.Add(@{
        n = $name
        v = $verb
        c = $category
        r = $siteRole
        e = $hasExamples
    })

    # Descriptions
    $descriptions[$name] = $synopsis

    # Module (category) file entry
    if (-not $moduleData.ContainsKey($slug)) { $moduleData[$slug] = @{} }
    $moduleData[$slug][$name] = @{
        syntax     = $syntaxText
        examples   = $examples
        parameters = $parameters
    }
}
Write-Progress -Activity 'Processing cmdlets' -Completed

#endregion

#region --- Write Output Files ---

# Get module version from module manifest
$modVersion = '5.2311.1093.1000'
try { $modVersion = (Get-Module ConfigurationManager).Version.ToString() } catch {}

$manifestObj = @{
    v = $modVersion
    d = $manifest.ToArray()
}

$manifestPath = Join-Path $OutputPath 'manifest.json'
$manifestObj | ConvertTo-Json -Depth 5 -Compress | Set-Content -Path $manifestPath -Encoding UTF8
Write-Host "Written: $manifestPath ($($manifest.Count) entries)" -ForegroundColor Green

$descPath = Join-Path $OutputPath 'descriptions.json'
$descriptions | ConvertTo-Json -Compress | Set-Content -Path $descPath -Encoding UTF8
Write-Host "Written: $descPath" -ForegroundColor Green

foreach ($slug in $moduleData.Keys) {
    $modFile = @{
        module  = $slug
        cmdlets = $moduleData[$slug]
    }
    $modPath = Join-Path $modulesDir "$slug.json"
    $modFile | ConvertTo-Json -Depth 10 -Compress | Set-Content -Path $modPath -Encoding UTF8
    Write-Host "Written: $modPath ($($moduleData[$slug].Count) cmdlets)" -ForegroundColor Green
}

Write-Host "`nDone! $($manifest.Count) cmdlets across $($moduleData.Count) categories." -ForegroundColor Cyan

#endregion
