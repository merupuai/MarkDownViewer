// cocoa-launcher.swift
//
// Tiny Cocoa wrapper around Electrobun's Zig launcher. Installs an
// NSAppleEventManager handler for kAEOpenDocuments so file double-clicks
// from Finder/LaunchServices are captured BEFORE we exec the real launcher.
//
// The captured URL is written to /tmp/mdv-pending-url-<pid> and exposed
// via MV_PENDING_URL environment variable. Bun reads either source.
//
// Compile: swiftc -O scripts/cocoa-launcher.swift -o build/tools/cocoa-launcher
import Cocoa
import Carbon

class AppDelegate: NSObject, NSApplicationDelegate {
    var receivedUrls: [URL] = []
    var didExec = false
    var execTimer: Timer?

    override init() {
        super.init()
        // Install Apple Event handler EARLY — before app.run() begins
        // dispatching events. NSApplicationDelegate.application(_:open:)
        // also covers this, but we belt-and-suspenders both.
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleAppleEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(kCoreEventClass),
            andEventID: AEEventID(kAEOpenDocuments)
        )
    }

    @objc func handleAppleEvent(_ event: NSAppleEventDescriptor, withReplyEvent: NSAppleEventDescriptor) {
        guard let listDescriptor = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)) else { return }
        for i in 1...max(1, listDescriptor.numberOfItems) {
            guard let item = listDescriptor.atIndex(i) else { continue }
            if let urlStr = item.stringValue, let url = URL(string: urlStr) {
                receivedUrls.append(url)
            } else if let fileURL = item.fileURLValue {
                receivedUrls.append(fileURL)
            }
        }
        scheduleExec(after: 0.05)
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        receivedUrls.append(contentsOf: urls)
        scheduleExec(after: 0.05)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Belt-and-suspenders: exec after a short delay even if no URL arrived.
        // (For "Open with no document" launches.)
        scheduleExec(after: 0.20)
    }

    func scheduleExec(after delay: TimeInterval) {
        if didExec { return }
        execTimer?.invalidate()
        execTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            self?.execIfReady()
        }
    }

    func execIfReady() {
        if didExec { return }
        didExec = true

        let pid = ProcessInfo.processInfo.processIdentifier
        let pendingFile = "/tmp/mdv-pending-url-\(pid)"
        if !receivedUrls.isEmpty {
            let lines = receivedUrls.map { $0.absoluteString }.joined(separator: "\n")
            try? lines.write(toFile: pendingFile, atomically: true, encoding: .utf8)
            if let first = receivedUrls.first {
                setenv("MV_PENDING_URL", first.absoluteString, 1)
            }
        }
        setenv("MV_LAUNCHER_PID", String(pid), 1)

        // Locate launcher.real next to ourselves.
        let exePath = Bundle.main.executablePath ?? CommandLine.arguments[0]
        let realLauncher = (exePath as NSString).deletingLastPathComponent + "/launcher.real"

        // Pass through any argv we got (rare for LaunchServices).
        var argv: [String] = [realLauncher]
        if CommandLine.arguments.count > 1 {
            argv.append(contentsOf: CommandLine.arguments.dropFirst())
        }

        // Convert to C string array and execv.
        var cArgv: [UnsafeMutablePointer<Int8>?] = argv.map { strdup($0) }
        cArgv.append(nil)
        let result = execv(realLauncher, &cArgv)
        FileHandle.standardError.write("execv failed: \(result), errno=\(errno) for \(realLauncher)\n".data(using: .utf8) ?? Data())
        exit(127)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// Use .regular so LaunchServices delivers AppleEvents to us. Once we exec
// into the real launcher, Bun will set its own activation policy.
app.setActivationPolicy(.regular)
app.run()
