---
external help file: Microsoft.Azure.PowerShell.Cmdlets.Test.dll-Help.xml
Module Name: Az.Test
title: New-AzThing
---

# New-AzThing

## SYNOPSIS
Creates a thing.

## SYNTAX

### ByName (Default)
```
New-AzThing -Name <String> [-DefaultProfile <IAzureContextContainer>]
```

### ByInputObject
```
# ParameterSetName: ByInputObject
New-AzThing -InputObject <PSThing> [-DefaultProfile <IAzureContextContainer>]
```

## EXAMPLES

### Example 1: Create a thing
```powershell
New-AzThing -Name "one"
```

```Output
Name ResourceGroupName
---- -----------------
one  rg
```

This command creates a thing.

### Example 2: Commented
```powershell
<#
Settings for the thing:
[ { "name": "two" } ]
#>
# set the resource group
$rg = "x"
New-AzThing -Name "two" # inline note
```

### Example 3: A template, not PowerShell
```json
{ "name": "three" }
```

### Example 4: Unlabelled
```
PS C:\> New-AzThing -Name "four"
```

### Example 5: Over the limit
```powershell
New-AzThing -Name "five"
```

## PARAMETERS
