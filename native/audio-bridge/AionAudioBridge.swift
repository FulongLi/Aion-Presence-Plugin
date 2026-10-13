// Aion Audio Bridge (v0.4.2, follow mode v0.4.3) — the macOS capture adapter for Codex's voice and other applications' sound.
//
// It captures audio output with a Core Audio process tap (macOS 14.2+): one application (every process of it mixed
// together), or the whole system mix. The samples go to exactly one place: the local Aion hub, over a private Unix socket
// in the user's own directory, where the shared Audio Analysis Engine (src/audio/analyzer.ts) reduces them to features in
// memory. Nothing is written to disk, sent over a network, transcribed or kept, and only the features reach the
// renderer. (Until v0.4.1 this experiment computed its own spectrum; Aion now has one analyser for every source.)
//
//   aion-audio-bridge list                                    audio clients: pid, bundle id, name, playing now or not
//   aion-audio-bridge stream --socket PATH --nonce N (--bundle ID | --pid N | --system) [--seconds S] [--follow]
//       --bundle ID   every process of that app (ID and ID.*, e.g. com.openai.codex and its helpers) mixed together
//       --follow      (v0.4.3) wait for the app's audio processes (sending "AION-WAIT1 <nonce>\n" meanwhile) and exit
//                     when they or the output device change, so the hub reconnects to the new ones
//       --name NAME   an application by name ("Music", "Spotify"), with all of its processes
//       --system      everything the Mac plays (a global tap), except this bridge itself
//   aion-audio-bridge probe (--bundle ID | --pid N | --system) [--seconds S]
//       taps for S seconds and prints a summary (peak level, callbacks, latency, CPU) to stdout: no samples leave it
//
// The stream protocol: once the tap really runs (macOS may first ask for permission), one line "AION-PCM1 <nonce>
// <sampleRate>\n", then frames of [UInt32 LE count][count × Float32 LE] mono samples; a frame with count 0 every half
// second is a keep-alive. The hub never writes: when it closes the socket, a watchdog sees it and the bridge exits at
// once (its private tap and aggregate device go with it), even while it is still waiting for permission. The tap is private (no other app sees it) and unmuted (the user
// still hears everything). macOS asks for "System Audio Recording Only" the first time (Privacy & Security → Screen &
// System Audio Recording); without it the tap hears silence.

import AudioToolbox
import CoreAudio
import Darwin
import Foundation

// MARK: - Core Audio helpers

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func read<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> T? {
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    var where_ = address(selector, scope)
    let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &where_, 0, nil, &size, $0) }
    return status == noErr ? value : nil
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var where_ = address(selector)
    guard AudioObjectGetPropertyData(object, &where_, 0, nil, &size, &value) == noErr, let string = value?.takeRetainedValue() else { return nil }
    return string as String
}

func readArray(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
    var where_ = address(selector)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &where_, 0, nil, &size) == noErr, size > 0 else { return [] }
    var items = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(object, &where_, 0, nil, &size, &items) == noErr else { return [] }
    return items
}

func processName(_ pid: pid_t) -> String {
    var buffer = [CChar](repeating: 0, count: 256)
    return proc_name(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : "?"
}

struct AudioClient { let object: AudioObjectID; let pid: pid_t; let bundle: String; let name: String; let playing: Bool }

func audioClients() -> [AudioClient] {
    readArray(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList).compactMap { object in
        guard let pid = read(object, kAudioProcessPropertyPID, pid_t(0)) else { return nil }
        let playing = (read(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)) ?? 0) != 0
        return AudioClient(object: object, pid: pid, bundle: readString(object, kAudioProcessPropertyBundleID) ?? "", name: processName(pid), playing: playing)
    }
}

func fail(_ message: String, _ status: OSStatus = 0) -> Never {
    FileHandle.standardError.write("aion-audio-bridge: \(message)\(status != 0 ? " (OSStatus \(status))" : "")\n".data(using: .utf8)!)
    exit(1)
}

// MARK: - Tap

final class Tap {
    private(set) var tapID = AudioObjectID(kAudioObjectUnknown)
    private(set) var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProc: AudioDeviceIOProcID?
    private(set) var format = AudioStreamBasicDescription()
    private(set) var callbacks = 0
    private(set) var frames = 0
    private(set) var lastFrameCount: UInt32 = 0
    var onSamples: ((UnsafeBufferPointer<Float>, Double) -> Void)?

    init(processes: [AudioObjectID], global: Bool = false) {
        let description = global ? CATapDescription(monoGlobalTapButExcludeProcesses: processes) : CATapDescription(monoMixdownOfProcesses: processes)
        description.uuid = UUID()
        description.isPrivate = true
        description.muteBehavior = .unmuted
        description.name = "Aion Audio Bridge"
        var status = AudioHardwareCreateProcessTap(description, &tapID)
        guard status == noErr else { fail("could not create the process tap", status) }
        guard let tapFormat = read(tapID, kAudioTapPropertyFormat, AudioStreamBasicDescription()) else { fail("could not read the tap format") }
        format = tapFormat
        guard let output = read(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, AudioObjectID(0)),
              let outputUID = readString(output, kAudioDevicePropertyDeviceUID) else { fail("no default output device") }
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Aion Audio Bridge",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard status == noErr else { fail("could not create the private aggregate device", status) }
    }

    func start() {
        let queue = DispatchQueue(label: "aion.audio-bridge", qos: .userInteractive)
        let channels = Int(max(1, format.mChannelsPerFrame)), rate = format.mSampleRate
        var status = AudioDeviceCreateIOProcIDWithBlock(&ioProc, aggregateID, queue) { [weak self] _, input, _, _, _ in
            guard let self else { return }
            let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
            guard let buffer = list.first, let data = buffer.mData else { return }
            let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            let samples = data.assumingMemoryBound(to: Float.self)
            // A mono tap is one channel; anything else is averaged to mono here.
            if channels == 1 || list.count > 1 {
                self.onSamples?(UnsafeBufferPointer(start: samples, count: count), Double(count) / rate)
            } else {
                var mono = [Float](repeating: 0, count: count / channels)
                for i in 0..<mono.count { var sum: Float = 0; for c in 0..<channels { sum += samples[i * channels + c] }; mono[i] = sum / Float(channels) }
                mono.withUnsafeBufferPointer { self.onSamples?($0, Double($0.count) / rate) }
            }
            self.callbacks += 1; self.frames += count / (list.count > 1 ? 1 : channels); self.lastFrameCount = UInt32(count / (list.count > 1 ? 1 : channels))
        }
        guard status == noErr else { fail("could not create the IO proc", status) }
        status = AudioDeviceStart(aggregateID, ioProc)
        guard status == noErr else { fail("could not start the tap", status) }
    }

    /// Input latency of the aggregate device (frames): device latency plus safety offset.
    func inputLatencyFrames() -> UInt32 {
        let latency = read(aggregateID, kAudioDevicePropertyLatency, UInt32(0), scope: kAudioObjectPropertyScopeInput) ?? 0
        let safety = read(aggregateID, kAudioDevicePropertySafetyOffset, UInt32(0), scope: kAudioObjectPropertyScopeInput) ?? 0
        return latency + safety
    }

    func stop() {
        if let ioProc { AudioDeviceStop(aggregateID, ioProc); AudioDeviceDestroyIOProcID(aggregateID, ioProc) }
        if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
    }
}

// MARK: - Commands

func option(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

/// The audio clients a command names: an app's whole family by bundle id or by name, or one pid (empty for --system).
func matchingClients() -> [AudioClient] {
    let clients = audioClients()
    var chosen: [AudioClient] = []
    if let pid = option("--pid").flatMap({ pid_t($0) }) { chosen = clients.filter { $0.pid == pid } }
    if let bundle = option("--bundle") { chosen = clients.filter { $0.bundle == bundle || $0.bundle.hasPrefix(bundle + ".") } }
    if let name = option("--name")?.lowercased() {
        // An application by the name people use ("Music", "Spotify"): its process name or the last part of its bundle id.
        chosen = clients.filter { $0.name.lowercased() == name || $0.bundle.lowercased().split(separator: ".").last.map(String.init) == name }
        if let family = chosen.first?.bundle, !family.isEmpty { chosen = clients.filter { $0.bundle == family || $0.bundle.hasPrefix(family + ".") } }
    }
    return chosen
}

/// The processes a command names: an app's whole family by bundle id, one pid, or (global) the processes to leave out.
func chooseTap() -> (tap: Tap, label: String, pids: Set<pid_t>) {
    if CommandLine.arguments.contains("--system") {
        let me = audioClients().filter { $0.pid == getpid() }.map(\.object)
        return (Tap(processes: me, global: true), "system", [])
    }
    let chosen = matchingClients()
    guard !chosen.isEmpty else { fail("no-such-client: no audio client matches (see: list)") }
    return (Tap(processes: chosen.map(\.object)), chosen.map { "\($0.pid) \($0.name)" }.joined(separator: ", "), Set(chosen.map(\.pid)))
}

/// Calls `changed` whenever a system audio property changes (the list of client processes, the default output device).
/// Core Audio notifies: nothing is polled.
func watch(_ selector: AudioObjectPropertySelector, on queue: DispatchQueue, _ changed: @escaping () -> Void) {
    var where_ = address(selector)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &where_, queue) { _, _ in changed() }
}

func cpuSeconds() -> Double {
    var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
    return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1e6
}

/// A connected Unix socket to the hub (the path must be in a directory only this user can enter).
func connectSocket(_ path: String) -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { fail("socket") }
    var on: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { fail("socket path too long") }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in for (i, b) in bytes.enumerated() { raw[i] = b }; raw[bytes.count] = 0 }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    let result = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) } }
    guard result == 0 else { fail("could not reach the Aion hub at \(path)") }
    return fd
}

/// Writes everything or reports the connection gone.
func writeAll(_ fd: Int32, _ data: UnsafeRawBufferPointer) -> Bool {
    var offset = 0
    while offset < data.count {
        let n = write(fd, data.baseAddress! + offset, data.count - offset)
        if n <= 0 { if n < 0 && errno == EINTR { continue }; return false }
        offset += n
    }
    return true
}

signal(SIGPIPE, SIG_IGN)
let command = CommandLine.arguments.dropFirst().first ?? "help"
switch command {
case "list":
    let clients = audioClients()
    print("pid\tplaying\tbundle\tname")
    for client in clients.sorted(by: { ($0.playing ? 0 : 1, $0.pid) < ($1.playing ? 0 : 1, $1.pid) }) {
        print("\(client.pid)\t\(client.playing ? "yes" : "no")\t\(client.bundle.isEmpty ? "-" : client.bundle)\t\(client.name)")
    }
case "stream":
    guard let path = option("--socket"), let nonce = option("--nonce"), nonce.range(of: "^[a-f0-9]{16,64}$", options: .regularExpression) != nil else {
        fail("usage: stream --socket PATH --nonce HEX (--bundle ID | --pid N | --system)")
    }
    let seconds = Double(option("--seconds") ?? "3600") ?? 3600
    let fd = connectSocket(path)
    // The hub never writes to the bridge: a socket that reads end-of-file has been closed by the hub. Checked on a queue
    // of its own, so the bridge exits even while macOS holds it in its permission check (the main thread may wait there).
    let watchdog = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "aion.audio-bridge.watchdog"))
    watchdog.schedule(deadline: .now() + 0.5, repeating: 0.5)
    watchdog.setEventHandler {
        var byte: UInt8 = 0
        let n = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
        if n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) { _exit(0) }
    }
    watchdog.resume()
    // --follow (v0.4.3, Codex Voice Sync): wait for the app's audio processes instead of failing, and end (so the hub
    // reconnects) when they change — a helper restarting — or when the output device changes.
    let follow = CommandLine.arguments.contains("--follow") && !CommandLine.arguments.contains("--system")
    let changes = DispatchQueue(label: "aion.audio-bridge.changes")
    if follow && matchingClients().isEmpty {
        let line = "AION-WAIT1 \(nonce)\n"
        guard line.utf8CString.withUnsafeBytes({ writeAll(fd, UnsafeRawBufferPointer(rebasing: $0.dropLast())) }) else { exit(0) }
        let appeared = DispatchSemaphore(value: 0)
        watch(kAudioHardwarePropertyProcessObjectList, on: changes) { if !matchingClients().isEmpty { appeared.signal() } }
        appeared.wait()
    }
    let (tap, label, tapped) = chooseTap()
    let writer = DispatchQueue(label: "aion.audio-bridge.writer", qos: .userInteractive)
    var alive = true, ready = false
    let stop: (Int32) -> Never = { code in tap.stop(); close(fd); exit(code) }
    tap.onSamples = { samples, _ in
        var frame = Data(capacity: 4 + samples.count * 4)
        var count = UInt32(samples.count).littleEndian
        withUnsafeBytes(of: &count) { frame.append(contentsOf: $0) }
        samples.withMemoryRebound(to: UInt8.self) { frame.append($0) }
        writer.async { if ready && alive && !frame.withUnsafeBytes({ writeAll(fd, $0) }) { alive = false; _exit(0) } }
    }
    // Starting the tap is where macOS checks "System Audio Recording": it may wait for the user's answer.
    tap.start()
    // Only now does the hub hear from the bridge, so "streaming" always means the tap really runs.
    writer.sync {
        let header = "AION-PCM1 \(nonce) \(Int(tap.format.mSampleRate))\n"
        ready = header.utf8CString.withUnsafeBytes { writeAll(fd, UnsafeRawBufferPointer(rebasing: $0.dropLast())) }
    }
    if !ready { stop(0) }
    FileHandle.standardError.write("streaming \(label) · \(Int(tap.format.mSampleRate)) Hz\n".data(using: .utf8)!)
    // Keep-alive: a zero-length frame every half second (the hub sees the bridge is there even while nothing plays).
    let keepAlive = DispatchSource.makeTimerSource(queue: writer)
    keepAlive.schedule(deadline: .now() + 0.5, repeating: 0.5)
    keepAlive.setEventHandler {
        var zero = UInt32(0)
        if alive && !withUnsafeBytes(of: &zero, { writeAll(fd, $0) }) { alive = false; _exit(0) }
    }
    keepAlive.resume()
    if follow {
        watch(kAudioHardwarePropertyProcessObjectList, on: changes) { if Set(matchingClients().map(\.pid)) != tapped { stop(0) } }
    }
    if CommandLine.arguments.contains("--follow") {
        watch(kAudioHardwarePropertyDefaultSystemOutputDevice, on: changes) { stop(0) }
    }
    for sig in [SIGINT, SIGTERM] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        source.setEventHandler { stop(0) }
        source.resume()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { stop(0) }
    dispatchMain()
case "probe":
    let seconds = Double(option("--seconds") ?? "5") ?? 5
    let (tap, label, _) = chooseTap()
    var peak: Float = 0
    let lock = NSLock()
    tap.onSamples = { samples, _ in
        var local: Float = 0
        for s in samples { local = max(local, abs(s)) }
        lock.lock(); peak = max(peak, local); lock.unlock()
    }
    let cpuStart = cpuSeconds(), wallStart = Date()
    tap.start()
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
        let wall = Date().timeIntervalSince(wallStart), rate = tap.format.mSampleRate
        let bufferMs = Double(tap.lastFrameCount) / rate * 1000, deviceMs = Double(tap.inputLatencyFrames()) / rate * 1000
        let summary: [String: Any] = [
            "tapped": label, "seconds": wall, "sampleRate": rate, "callbacks": tap.callbacks, "framesPerCallback": tap.lastFrameCount,
            "bufferMs": bufferMs, "deviceLatencyMs": deviceMs, "cpuPercent": wall > 0 ? (cpuSeconds() - cpuStart) / wall * 100 : 0,
            "peak": peak, "silentCapture": tap.callbacks > 0 && peak < 1e-5,
        ]
        let json = try! JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys])
        print(String(data: json, encoding: .utf8)!)
        tap.stop()
        exit(0)
    }
    dispatchMain()
default:
    print("usage: aion-audio-bridge list | stream --socket PATH --nonce HEX (--bundle ID | --pid N | --system) [--seconds S] | probe (--bundle ID | --pid N | --system) [--seconds S]")
}
