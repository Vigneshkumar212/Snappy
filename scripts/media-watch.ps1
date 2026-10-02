param([int]$ParentPid, [int]$PollMs = 1000)

# Watches Windows' media session (the same source as the volume flyout) and prints one JSON line
# whenever the track, play state, artwork or playback position (seek) changes:
#   {"key":"...","title":"...","artist":"...","album":"...","app":"...","status":"Playing",
#    "pos":12.3,"dur":161.6,"art":"data:image/jpeg;base64,..."}
# "art" is only sent when the track changes (or when artwork arrives late). Prints "null" when
# nothing is playing.
#
# Also reads commands from stdin, one per line: toggle | next | prev. They're applied to the
# current session straight away, and the new state is reported on the next quick poll.
# Exits on its own if the parent Electron process disappears.

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType=WindowsRuntime]

# Reads stdin on a background thread so the poll loop never blocks on it.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Threading;

public static class CommandQueue {
    public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();

    public static void Start() {
        var thread = new Thread(() => {
            string line;
            while ((line = Console.In.ReadLine()) != null) Lines.Enqueue(line.Trim());
        });
        thread.IsBackground = true;
        thread.Start();
    }
}
'@
[CommandQueue]::Start()

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    [void]$task.Wait(-1)
    $task.Result
}

# PowerShell can't resolve the AsStreamForRead overload for WinRT streams directly, so go via reflection.
$asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

function Get-ArtDataUrl($thumbnail) {
    if (-not $thumbnail) { return $null }
    try {
        $stream = Await ($thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $reader = $asStreamForRead.Invoke($null, @($stream))
        $memory = New-Object System.IO.MemoryStream
        $reader.CopyTo($memory)
        if ($memory.Length -eq 0) { return $null }

        $bytes = $memory.ToArray()
        $mime = if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { 'image/png' }
                elseif ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xD8) { 'image/jpeg' }
                elseif ($bytes[0] -eq 0x52 -and $bytes[1] -eq 0x49) { 'image/webp' }
                else { 'image/jpeg' }
        return "data:$mime;base64," + [Convert]::ToBase64String($bytes)
    } catch {
        return $null
    }
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$manager = Await ($managerType::RequestAsync()) $managerType

# Prefer something that is actually playing; otherwise whatever Windows considers current.
function Get-Session {
    $playing = @($manager.GetSessions()) | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
    if ($playing) { return $playing }
    $manager.GetCurrentSession()
}

function Send-MediaCommand($command) {
    $session = Get-Session
    if (-not $session) { return }
    try {
        switch ($command) {
            'toggle' { [void](Await ($session.TryTogglePlayPauseAsync()) ([bool])) }
            'next'   { [void](Await ($session.TrySkipNextAsync()) ([bool])) }
            'prev'   { [void](Await ($session.TrySkipPreviousAsync()) ([bool])) }
        }
    } catch { }
}

$lastKey = $null
$artSent = $false
$artTries = 0
$lastSent = $null   # @{ status; pos; at } for detecting seeks
$lastLine = $null

# Returns the JSON line to report right now ("null" when nothing is playing).
function Get-State {
    $session = Get-Session
    if (-not $session) { $script:lastKey = $null; $script:lastSent = $null; return 'null' }

    $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
    $status = [string]$session.GetPlaybackInfo().PlaybackStatus
    $timeline = $session.GetTimelineProperties()

    if (-not $props.Title -or $status -eq 'Closed' -or $status -eq 'Stopped') {
        $script:lastKey = $null; $script:lastSent = $null
        return 'null'
    }

    $key = "$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"
    $trackChanged = $key -ne $script:lastKey
    if ($trackChanged) { $script:lastKey = $key; $script:artSent = $false; $script:artTries = 0 }

    $duration = [math]::Round(($timeline.EndTime - $timeline.StartTime).TotalSeconds, 1)
    $pos = ($timeline.Position - $timeline.StartTime).TotalSeconds
    if ($status -eq 'Playing') { $pos += ([DateTimeOffset]::UtcNow - $timeline.LastUpdatedTime).TotalSeconds }
    $pos = [math]::Round([math]::Max(0, [math]::Min($pos, $(if ($duration -gt 0) { $duration } else { $pos }))), 1)

    $payload = [ordered]@{
        key = $key; title = $props.Title; artist = $props.Artist; album = $props.AlbumTitle
        app = $session.SourceAppUserModelId; status = $status; pos = $pos; dur = $duration
    }

    # Artwork can show up a moment after the title; keep trying briefly.
    $withArt = $false
    if (-not $script:artSent -and $script:artTries -lt 8) {
        $script:artTries++
        $art = Get-ArtDataUrl $props.Thumbnail
        if ($art) { $payload.art = $art; $script:artSent = $true; $withArt = $true }
    }

    # Report on track/state/art change, or when playback drifted from where we expected (a seek).
    $last = $script:lastSent
    $expected = if ($last -and $last.status -eq 'Playing') { $last.pos + ([DateTime]::UtcNow - $last.at).TotalSeconds } elseif ($last) { $last.pos } else { -99 }
    $changed = $trackChanged -or $withArt -or (-not $last) -or ($last.status -ne $status) -or ([math]::Abs($pos - $expected) -gt 1.5)
    if (-not $changed) { return $script:lastLine }

    $script:lastSent = @{ status = $status; pos = $pos; at = [DateTime]::UtcNow }
    ConvertTo-Json -InputObject $payload -Compress
}

$nextPoll = [DateTime]::UtcNow

while ($true) {
    if ($ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }

    # Commands from the dock: apply, then re-poll shortly so the new state is reported fast.
    $command = $null
    while ([CommandQueue]::Lines.TryDequeue([ref]$command)) {
        Send-MediaCommand $command
        $nextPoll = [DateTime]::UtcNow.AddMilliseconds(150)
    }

    if ([DateTime]::UtcNow -ge $nextPoll) {
        try { $line = Get-State } catch { $line = $lastLine }  # transient WinRT hiccup: keep the previous state

        if ($line -ne $lastLine) {
            [Console]::Out.WriteLine($line)
            [Console]::Out.Flush()
            $lastLine = $line
        }
        $nextPoll = [DateTime]::UtcNow.AddMilliseconds($PollMs)
    }

    Start-Sleep -Milliseconds 80
}
