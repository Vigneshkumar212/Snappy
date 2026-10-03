param([int]$ParentPid, [int]$IntervalMs = 2000)

# Prints one JSON line per interval with the current network speed in bytes per second:
#   {"down":123456,"up":7890}
# Counts every adapter that's up, except loopback, tunnels and virtual switches (WSL/Hyper-V), whose
# traffic would otherwise be counted twice. Exits on its own if the parent Electron process disappears.
# Snappy only runs this while the System tab is open.

function Get-Totals {
    $received = 0L
    $sent = 0L

    foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($nic.OperationalStatus -ne 'Up') { continue }
        if ($nic.NetworkInterfaceType -eq 'Loopback' -or $nic.NetworkInterfaceType -eq 'Tunnel') { continue }
        if ($nic.Name -match 'vEthernet|Loopback|Pseudo') { continue }

        $stats = $nic.GetIPv4Statistics()
        $received += $stats.BytesReceived
        $sent += $stats.BytesSent
    }

    [pscustomobject]@{ received = $received; sent = $sent; at = [DateTime]::UtcNow }
}

$previous = Get-Totals

while ($true) {
    if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }

    Start-Sleep -Milliseconds $IntervalMs

    $now = Get-Totals
    $seconds = ($now.at - $previous.at).TotalSeconds
    if ($seconds -le 0) { continue }

    $down = [math]::Max(0, ($now.received - $previous.received) / $seconds)
    $up = [math]::Max(0, ($now.sent - $previous.sent) / $seconds)
    $previous = $now

    [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ down = [int64]$down; up = [int64]$up } -Compress))
    [Console]::Out.Flush()
}
