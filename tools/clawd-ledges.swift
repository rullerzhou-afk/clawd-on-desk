// clawd-ledges.swift — window-ledge sidecar for the Gravity toggle (macOS).
//
// Streams JSON lines describing the visible TOP EDGES of normal app windows
// (front-to-back occlusion resolved), in global top-left-origin coordinates —
// the same space Electron uses on macOS, so the consumer needs no conversion.
// Zero TCC permissions: bounds/layer/PID/alpha only, never window titles.
//
// Usage: clawd-ledges-sidecar <excludePid> <petHeightPx>
// Output: {"t":<ms>,"ledges":[{"id":N,"pid":N,"x":N,"x2":N,"y":N},...]}
// Emits on change, plus a heartbeat every ~2s so consumers can detect death.
//
// Build: swiftc -O tools/clawd-ledges.swift -o clawd-ledges-sidecar

import CoreGraphics
import Foundation

let args = CommandLine.arguments
let excludePid: Int32 = args.count > 1 ? Int32(args[1]) ?? -1 : -1
let petH: Double = args.count > 2 ? Double(args[2]) ?? 120 : 120
let cornerInset = 14.0
let minSegment = 60.0
let pollMicros: useconds_t = 200_000   // 5 Hz
let heartbeatEvery = 10                // polls (≈2 s)

struct Win {
    let id: UInt32
    let pid: Int32
    let layer: Int
    let alpha: Double
    let b: CGRect
}

func fetchWindows() -> [Win]? {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let raw = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]]
    else { return nil }
    return raw.compactMap { d in
        guard let id = d[kCGWindowNumber as String] as? UInt32,
              let pid = d[kCGWindowOwnerPID as String] as? Int32, pid != excludePid,
              let layer = d[kCGWindowLayer as String] as? Int, layer >= 0,
              let bd = d[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: bd)
        else { return nil }
        let alpha = d[kCGWindowAlpha as String] as? Double ?? 1.0
        guard alpha > 0.1 else { return nil }
        return Win(id: id, pid: pid, layer: layer, alpha: alpha, b: r)
    }
}

func subtract(_ cut: ClosedRange<Double>, from list: [ClosedRange<Double>]) -> [ClosedRange<Double>] {
    var out: [ClosedRange<Double>] = []
    for iv in list {
        if cut.upperBound <= iv.lowerBound || cut.lowerBound >= iv.upperBound {
            out.append(iv)
            continue
        }
        if cut.lowerBound > iv.lowerBound { out.append(iv.lowerBound...cut.lowerBound) }
        if cut.upperBound < iv.upperBound { out.append(cut.upperBound...iv.upperBound) }
    }
    return out
}

/// Front-to-back order (CGWindowList guarantee): earlier index occludes later.
func computeLedges(_ wins: [Win]) -> [[String: Any]] {
    var out: [[String: Any]] = []
    for (i, w) in wins.enumerated() {
        guard w.layer == 0, w.alpha > 0.85,
              w.b.width >= 120, w.b.height >= 60 else { continue }
        let edgeY = Double(w.b.minY)   // y-down: minY is the visual top
        let lo = Double(w.b.minX) + cornerInset
        let hi = Double(w.b.maxX) - cornerInset
        guard hi - lo >= minSegment else { continue }
        var visible: [ClosedRange<Double>] = [lo...hi]
        for f in wins[..<i] {
            // occludes when it overlaps the strip the pet occupies above the edge
            guard Double(f.b.minY) < edgeY, Double(f.b.maxY) > edgeY - petH else { continue }
            visible = subtract(Double(f.b.minX)...Double(f.b.maxX), from: visible)
            if visible.isEmpty { break }
        }
        for seg in visible where seg.upperBound - seg.lowerBound >= minSegment {
            out.append([
                "id": Int(w.id), "pid": Int(w.pid),
                "x": (seg.lowerBound * 10).rounded() / 10,
                "x2": (seg.upperBound * 10).rounded() / 10,
                "y": (edgeY * 10).rounded() / 10,
            ])
        }
    }
    return out
}

var lastPayload = ""
var pollsSinceEmit = 0

while true {
    if let wins = fetchWindows() {
        let ledges = computeLedges(wins)
        let body: [String: Any] = ["ledges": ledges]
        if let data = try? JSONSerialization.data(withJSONObject: body),
           var line = String(data: data, encoding: .utf8) {
            pollsSinceEmit += 1
            if line != lastPayload || pollsSinceEmit >= heartbeatEvery {
                lastPayload = line
                pollsSinceEmit = 0
                line.removeLast()   // strip trailing }
                print(line + ",\"t\":\(Int(Date().timeIntervalSince1970 * 1000))}")
                fflush(stdout)
            }
        }
    }
    usleep(pollMicros)
}
