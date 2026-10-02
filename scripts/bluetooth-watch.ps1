param([int]$ParentPid, [int]$IntervalMs = 1500)

# Prints one JSON line (an array of connected Bluetooth devices) at startup and whenever it changes:
#   [{"name":"Buds","battery":13}, {"name":"Controller","battery":null}]
# Exits on its own if the parent Electron process disappears.

$KeyConnected = '{83DA6326-97A6-4088-9453-A1923F573B29} 15'
$KeyBattery   = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'

# Device nodes are what we report on. Battery lives on the device node itself, or on its
# Hands-Free (headsets, 111E/111F) or GATT Battery (BLE, 180F) service node.
$DeviceNodePattern  = '^BTH(ENUM|LE)\\DEV_([0-9A-Fa-f]{12})'
$BatteryNodePattern = '0000111E|0000111F|0000180F'

function Get-ConnectedDevices($nodes) {
    $relevant = @($nodes | Where-Object { $_.InstanceId -match $DeviceNodePattern -or $_.InstanceId -match $BatteryNodePattern })
    $props = @($relevant | Get-PnpDeviceProperty -KeyName $KeyConnected, $KeyBattery -ErrorAction SilentlyContinue |
        Where-Object { $_.Type -ne 'Empty' })

    $found = @{}
    foreach ($dev in $nodes) {
        if ($dev.InstanceId -notmatch $DeviceNodePattern) { continue }
        $address = $Matches[2]

        $connected = $props | Where-Object { $_.InstanceId -eq $dev.InstanceId -and $_.KeyName -eq $KeyConnected }
        if (-not $connected -or -not $connected.Data) { continue }

        $battery = $null
        $reading = $props | Where-Object {
            $_.KeyName -eq $KeyBattery -and $_.InstanceId -like "*$address*"
        } | Select-Object -First 1
        if ($reading) { $battery = [int]$reading.Data }

        # The same device can appear as both a classic and an LE node; keep one entry per name.
        $name = $dev.FriendlyName
        if (-not $found.ContainsKey($name) -or ($null -eq $found[$name].battery -and $null -ne $battery)) {
            $found[$name] = [ordered]@{ name = $name; battery = $battery }
        }
    }

    @($found.Values | Sort-Object { $_.name })
}

$nodes = @()
$last = $null
$tick = 0

while ($true) {
    if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }

    # Re-list nodes now and then so newly paired devices get picked up.
    if ($tick % 10 -eq 0) {
        $nodes = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'BTH*' })
    }
    $tick++

    $json = ConvertTo-Json -InputObject @(Get-ConnectedDevices $nodes) -Compress
    if ($json -ne $last) {
        Write-Output $json
        $last = $json
    }
    Start-Sleep -Milliseconds $IntervalMs
}
