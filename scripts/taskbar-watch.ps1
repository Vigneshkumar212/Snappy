param([int]$ParentPid, [int]$IntervalMs = 1000)

# Prints one JSON line at startup and whenever the taskbar moves or changes size:
#   {"edge":"left","size":0.031}
# "edge" is the screen edge the taskbar is on (bottom, top, left or right). "size" is its thickness
# as a fraction of the screen's width (left/right) or height (top/bottom), so Electron can turn it
# into its own units whatever the display scaling. Works when the taskbar is auto-hidden too, which
# Electron's work area can't tell us. Exits on its own if the parent Electron process disappears.

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class Taskbar {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct APPBARDATA {
        public int cbSize;
        public IntPtr hWnd;
        public uint uCallbackMessage;
        public uint uEdge;
        public RECT rc;
        public IntPtr lParam;
    }

    [DllImport("shell32.dll")]
    static extern UIntPtr SHAppBarMessage(uint dwMessage, ref APPBARDATA pData);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    const uint ABM_GETTASKBARPOS = 5;

    // Edge (0 left, 1 top, 2 right, 3 bottom, -1 unknown), thickness and the screen size, all in
    // physical pixels so they agree with each other.
    public static int[] Get() {
        var data = new APPBARDATA();
        data.cbSize = Marshal.SizeOf(typeof(APPBARDATA));
        if (SHAppBarMessage(ABM_GETTASKBARPOS, ref data) == UIntPtr.Zero) return new int[] { -1, 0, 0, 0 };

        int width = data.rc.Right - data.rc.Left;
        int height = data.rc.Bottom - data.rc.Top;
        int thickness = (data.uEdge == 0 || data.uEdge == 2) ? width : height;
        return new int[] { (int)data.uEdge, thickness, GetSystemMetrics(0), GetSystemMetrics(1) };
    }
}
'@

# So the taskbar's rectangle and the screen size are both in real pixels, not scaled guesses.
[void][Taskbar]::SetProcessDPIAware()

$edges = @{ 0 = 'left'; 1 = 'top'; 2 = 'right'; 3 = 'bottom' }
$last = $null

while ($true) {
    if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }

    $edge, $thickness, $screenWidth, $screenHeight = [Taskbar]::Get()
    if ($edges.ContainsKey($edge) -and $thickness -gt 0) {
        $across = if ($edge -eq 0 -or $edge -eq 2) { $screenWidth } else { $screenHeight }
        if ($across -gt 0) {
            $json = ConvertTo-Json -Compress -InputObject ([ordered]@{
                edge = $edges[$edge]
                size = [math]::Round($thickness / $across, 5)
            })
            if ($json -ne $last) {
                [Console]::Out.WriteLine($json)
                [Console]::Out.Flush()
                $last = $json
            }
        }
    }

    Start-Sleep -Milliseconds $IntervalMs
}
