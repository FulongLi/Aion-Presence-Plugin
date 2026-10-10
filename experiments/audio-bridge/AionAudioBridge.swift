// Aion Audio Bridge — experimental (v0.4). Not part of the plugin runtime.
//
// Captures ONE process's audio output with a Core Audio process tap (macOS 14.2+) and reduces it, in memory, to the
// features Aion's body can use: loudness (RMS), 16 spectrum bands and voice activity. Nothing else leaves it: no
// audio is written, sent, transcribed or kept; frames go to stdout as JSON lines (or nowhere).
//
//   aion-audio-bridge list                          audio clients: pid, bundle id, name, playing now or not
//   aion-audio-bridge tap --pid N [--seconds S]     tap that process's output, print feature frames
//   aion-audio-bridge tap --bundle ID [...]         every process of that app (ID and ID.*, e.g. com.openai.codex and its
//                                                   helpers) mixed together: whichever of them speaks is heard
//   aion-audio-bridge tap ... --quiet               no frames, only the summary (latency, CPU, levels)
//
// The tap is private (no other app sees it) and unmuted (the user still hears the audio). macOS asks for the
// "System Audio Recording Only" permission the first time (Privacy & Security → Screen & System Audio Recording).

import Accelerate
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

// MARK: - Features (Aion only ever sees these)

/// SCF Presence's log-spaced band edges (Hz): speech fundamentals and consonants each get their own movement.
let bandEdges: [Float] = [60, 90, 135, 200, 290, 420, 600, 850, 1200, 1700, 2400, 3400, 4800, 6800, 9500, 13000, 18000]

final class FeatureExtractor {
    let fftSize = 1024
    let sampleRate: Float
    private var ring = [Float](repeating: 0, count: 1024)
    private var filled = 0
    private let window: [Float]
    private let fft: vDSP.FFT<DSPSplitComplex>
    private(set) var bands = [Float](repeating: 0, count: 16)
    private(set) var rms: Float = 0
    private(set) var level: Float = 0
    private(set) var voiced = false
    private var floor: Float = 0.002
    private var hangover = 0.0
    private let lock = NSLock()

    init(sampleRate: Float) {
        self.sampleRate = sampleRate
        window = vDSP.window(ofType: Float.self, usingSequence: .hanningDenormalized, count: 1024, isHalfWindow: false)
        fft = vDSP.FFT(log2n: 10, radix: .radix2, ofType: DSPSplitComplex.self)!
    }

    /// Called on the audio thread with one block of mono samples.
    func push(_ samples: UnsafeBufferPointer<Float>, seconds: Double) {
        guard !samples.isEmpty else { return }
        let blockRMS = vDSP.rootMeanSquare(samples)
        // Slide the analysis window.
        let n = min(samples.count, fftSize)
        lock.lock(); defer { lock.unlock() }
        ring.removeFirst(n); ring.append(contentsOf: samples.suffix(n))
        filled = min(fftSize, filled + n)
        rms += (blockRMS - rms) * (blockRMS > rms ? 0.6 : 0.15)
        // A slow noise floor and a hangover: voice is "on" while clearly above the floor, and through short gaps.
        if blockRMS < floor * 2 { floor += (blockRMS - floor) * 0.02 } else { floor += (blockRMS - floor) * 0.0005 }
        floor = max(0.0005, min(0.05, floor))
        if blockRMS > max(0.006, floor * 3) { hangover = 0.25 } else { hangover -= seconds }
        voiced = hangover > 0
        level = min(1, max(0, (20 * log10(max(rms, 1e-6)) + 52) / 40))
        guard filled == fftSize else { return }
        var real = [Float](repeating: 0, count: fftSize / 2), imag = [Float](repeating: 0, count: fftSize / 2)
        let windowed = vDSP.multiply(ring, window)
        real.withUnsafeMutableBufferPointer { r in imag.withUnsafeMutableBufferPointer { i in
            var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
            windowed.withUnsafeBufferPointer { w in
                w.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: fftSize / 2) { vDSP_ctoz($0, 2, &split, 1, vDSP_Length(fftSize / 2)) }
            }
            fft.forward(input: split, output: &split)
            var magnitudes = [Float](repeating: 0, count: fftSize / 2)
            vDSP.absolute(split, result: &magnitudes)
            let binHz = sampleRate / Float(fftSize)
            for band in 0..<16 {
                let lo = max(1, Int(bandEdges[band] / binHz)), hi = min(fftSize / 2 - 1, max(lo + 1, Int(bandEdges[band + 1] / binHz)))
                var peak: Float = 0
                for bin in lo..<hi { peak = max(peak, magnitudes[bin]) }
                let db = 20 * log10(max(peak / Float(fftSize), 1e-7))
                let target = voiced ? min(1, max(0, (db + 72) / 48)) : 0
                bands[band] += (target - bands[band]) * (target > bands[band] ? 0.7 : 0.2)
            }
        } }
    }

    func snapshot() -> (rms: Float, level: Float, voiced: Bool, bands: [Float]) {
        lock.lock(); defer { lock.unlock() }
        return (rms, level, voiced, bands)
    }
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

    init(processes: [AudioObjectID]) {
        let description = CATapDescription(monoMixdownOfProcesses: processes)
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

let command = CommandLine.arguments.dropFirst().first ?? "help"
switch command {
case "list":
    let clients = audioClients()
    print("pid\tplaying\tbundle\tname")
    for client in clients.sorted(by: { ($0.playing ? 0 : 1, $0.pid) < ($1.playing ? 0 : 1, $1.pid) }) {
        print("\(client.pid)\t\(client.playing ? "yes" : "no")\t\(client.bundle.isEmpty ? "-" : client.bundle)\t\(client.name)")
    }
case "tap":
    let clients = audioClients()
    var chosen: [AudioClient] = []
    if let pid = option("--pid").flatMap({ pid_t($0) }) { chosen = clients.filter { $0.pid == pid } }
    if let bundle = option("--bundle") { chosen = clients.filter { $0.bundle == bundle || $0.bundle.hasPrefix(bundle + ".") } }
    guard let client = chosen.first else { fail("no such audio client (see: list)") }
    let seconds = Double(option("--seconds") ?? "10") ?? 10
    let quiet = CommandLine.arguments.contains("--quiet")
    let tap = Tap(processes: chosen.map(\.object))
    let features = FeatureExtractor(sampleRate: Float(tap.format.mSampleRate))
    var peak: Float = 0, voicedFrames = 0, printed = 0
    tap.onSamples = { samples, duration in features.push(samples, seconds: duration) }
    var usageStart = rusage(); getrusage(RUSAGE_SELF, &usageStart)
    let wallStart = Date()
    tap.start()
    FileHandle.standardError.write("tapping \(chosen.map { "\($0.pid) \($0.name)" }.joined(separator: ", ")) · \(Int(tap.format.mSampleRate)) Hz · \(tap.format.mChannelsPerFrame) ch\n".data(using: .utf8)!)
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 0.033, repeating: 1.0 / 30)
    timer.setEventHandler {
        let frame = features.snapshot()
        peak = max(peak, frame.rms); if frame.voiced { voicedFrames += 1 }; printed += 1
        if !quiet {
            let bands = frame.bands.map { String(format: "%.2f", $0) }.joined(separator: ",")
            print(String(format: "{\"t\":%.3f,\"rms\":%.4f,\"level\":%.2f,\"voice\":%@,\"bands\":[%@]}", Date().timeIntervalSince(wallStart), frame.rms, frame.level, frame.voiced ? "true" : "false", bands))
            fflush(stdout)
        }
    }
    timer.resume()
    signal(SIGINT, SIG_IGN)
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    let finish = {
        timer.cancel()
        var usageEnd = rusage(); getrusage(RUSAGE_SELF, &usageEnd)
        let wall = Date().timeIntervalSince(wallStart)
        let cpu = (Double(usageEnd.ru_utime.tv_sec - usageStart.ru_utime.tv_sec) + Double(usageEnd.ru_utime.tv_usec - usageStart.ru_utime.tv_usec) / 1e6)
            + (Double(usageEnd.ru_stime.tv_sec - usageStart.ru_stime.tv_sec) + Double(usageEnd.ru_stime.tv_usec - usageStart.ru_stime.tv_usec) / 1e6)
        let rate = tap.format.mSampleRate
        let bufferMs = Double(tap.lastFrameCount) / rate * 1000, deviceMs = Double(tap.inputLatencyFrames()) / rate * 1000
        let summary: [String: Any] = [
            "pids": chosen.map(\.pid), "bundle": client.bundle, "names": chosen.map(\.name), "seconds": wall, "sampleRate": rate,
            "callbacks": tap.callbacks, "framesPerCallback": tap.lastFrameCount, "bufferMs": bufferMs, "deviceLatencyMs": deviceMs,
            "featureFrameMs": 33.3, "estimatedLatencyMs": bufferMs + deviceMs + 16.7, "cpuPercent": wall > 0 ? cpu / wall * 100 : 0,
            "peakRms": peak, "voicedShare": printed > 0 ? Double(voicedFrames) / Double(printed) : 0,
            "silentCapture": tap.callbacks > 0 && peak < 1e-5,
        ]
        let json = try! JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys])
        FileHandle.standardError.write(("summary " + String(data: json, encoding: .utf8)! + "\n").data(using: .utf8)!)
        tap.stop()
        exit(0)
    }
    interrupt.setEventHandler(handler: finish)
    interrupt.resume()
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: finish)
    dispatchMain()
default:
    print("usage: aion-audio-bridge list | tap (--pid N | --bundle ID) [--seconds S] [--quiet]")
}
