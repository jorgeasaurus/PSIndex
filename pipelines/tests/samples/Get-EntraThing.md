---
title: Get-EntraThing
document type: cmdlet
---

## SYNOPSIS
Gets a thing.

## SYNTAX

### GetQuery (Default)
```powershell
Get-EntraThing [-Top <Int32>] [<CommonParameters>]
```

### GetById
```powershell
# ParameterSetName: GetById
Get-EntraThing -ThingId <String> [<CommonParameters>]
```

## EXAMPLES

### Example 1: Get the top three
```powershell
Connect-Entra -Scopes 'User.Read.All'
Get-EntraThing -Top 3
```

```Output
DisplayName Id
----------- --
a           1
```

This example gets the top three things.

### Example 2: Get a thing by ID
```PowerShell
PS C:\> Get-EntraThing -ThingId 'x'
```

### Example 3: A prompt with no path
```powershell
PS>Get-EntraThing -ThingId 'y'
```

### Example 4: Over the limit
```powershell
PS /home> Get-EntraThing -ThingId 'z'
```

### Example 5: Over the limit
```powershell
Get-EntraThing -All
```

## PARAMETERS
