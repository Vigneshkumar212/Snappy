param([int]$ParentPid)

# Prints "1" when a full-screen app/game/presentation is in the foreground and "0" when not.
# Only prints on change. Exits on its own if the parent Electron process disappears.

Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class Shell {
    [DllImport("shell32.dll")]
    public static extern int SHQueryUserNotificationState(out int state);
}
'@

# QUNS_BUSY = 2 (full-screen app), QUNS_RUNNING_D3D_FULL_SCREEN = 3, QUNS_PRESENTATION_MODE = 4
$last = -1
while ($true) {
    if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }

    $state = 0
    [void][Shell]::SHQueryUserNotificationState([ref]$state)
    $full = if ($state -in 2, 3, 4) { 1 } else { 0 }

    if ($full -ne $last) {
        Write-Output $full
        $last = $full
    }
    Start-Sleep -Milliseconds 400
}
