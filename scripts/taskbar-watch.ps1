param([int]$ParentPid, [int]$IntervalMs = 1000)

# Prints one JSON line at startup and whenever the taskbar moves or changes size:
#   {"edge":"left","size":0.031,"tray":0.724}
# "edge" is the screen edge the taskbar is on (bottom, top, left or right). "size" is its thickness
# as a fraction of the screen's width (left/right) or height (top/bottom). "tray" is where the
# notification area (clock, tray icons) starts along the taskbar, as a fraction of the screen's
# height (left/right) or width (top/bottom); it's null if the tray can't be found. Fractions let
# Electron turn them into its own units whatever the display scaling. Works when the taskbar is
# auto-hidden too, which Electron's work area can't tell us.
# Exits on its own if the parent Electron process disappears.

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

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string windowName);

    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    const uint ABM_GETTASKBARPOS = 5;

    // Edge (0 left, 1 top, 2 right, 3 bottom, -1 unknown), thickness, where the tray starts along
    // the taskbar (-1 if not found) and the screen size, all in physical pixels so they agree.
    public static int[] Get() {
        var data = new APPBARDATA();
        data.cbSize = Marshal.SizeOf(typeof(APPBARDATA));
        if (SHAppBarMessage(ABM_GETTASKBARPOS, ref data) == UIntPtr.Zero) return new int[] { -1, 0, -1, 0, 0 };

        bool vertical = data.uEdge == 0 || data.uEdge == 2;
        int thickness = vertical ? data.rc.Right - data.rc.Left : data.rc.Bottom - data.rc.Top;

        // The notification area is a child window of the taskbar; its near edge is where the free
        // space after the app icons ends.
        int tray = -1;
        IntPtr taskbar = FindWindow("Shell_TrayWnd", null);
        IntPtr notify = taskbar == IntPtr.Zero ? IntPtr.Zero : FindWindowEx(taskbar, IntPtr.Zero, "TrayNotifyWnd", null);
        RECT rect;
        if (notify != IntPtr.Zero && GetWindowRect(notify, out rect) && rect.Right > rect.Left && rect.Bottom > rect.Top) {
            tray = vertical ? rect.Top : rect.Left;
        }

        return new int[] { (int)data.uEdge, thickness, tray, GetSystemMetrics(0), GetSystemMetrics(1) };
    }
}
'@

# So the taskbar's rectangle and the screen size are both in real pixels, not scaled guesses.
[void][Taskbar]::SetProcessDPIAware()

$edges = @{ 0 = 'left'; 1 = 'top'; 2 = 'right'; 3 = 'bottom' }
$last = $null

while ($true) {
    if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }

    $edge, $thickness, $tray, $screenWidth, $screenHeight = [Taskbar]::Get()
    if ($edges.ContainsKey($edge) -and $thickness -gt 0) {
        $vertical = $edge -eq 0 -or $edge -eq 2
        $across = if ($vertical) { $screenWidth } else { $screenHeight }
        $along = if ($vertical) { $screenHeight } else { $screenWidth }
        if ($across -gt 0 -and $along -gt 0) {
            $json = ConvertTo-Json -Compress -InputObject ([ordered]@{
                edge = $edges[$edge]
                size = [math]::Round($thickness / $across, 5)
                tray = if ($tray -gt 0) { [math]::Round($tray / $along, 5) } else { $null }
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
