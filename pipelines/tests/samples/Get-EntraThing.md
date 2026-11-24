---
title: Get-EntraThing
---

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

## PARAMETERS
