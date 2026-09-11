import Foundation

// Find ev_notifier.py relative to this launcher
let launcherPath = CommandLine.arguments[0]
let launcherDir = URL(fileURLWithPath: launcherPath)
    .deletingLastPathComponent()  // MacOS/
    .deletingLastPathComponent()  // Contents/
    .deletingLastPathComponent()  // EvNotifier.app/
let pythonScript = launcherDir.appendingPathComponent("ev_notifier.py").path

// Find python3
let pythonPaths = [
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3"
]
let pythonPath = pythonPaths.first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/bin/python3"

let task = Process()
task.executableURL = URL(fileURLWithPath: pythonPath)
task.arguments = [pythonScript]
task.currentDirectoryURL = launcherDir

do {
    try task.run()
    task.waitUntilExit()
} catch {
    fputs("Failed to launch Python: \(error)\n", stderr)
    exit(1)
}