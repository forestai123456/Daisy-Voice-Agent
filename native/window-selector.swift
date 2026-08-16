import CoreGraphics
import Foundation

struct WindowInfo: Codable {
    let id: UInt32
    let owner: String
    let name: String
    let layer: Int
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

var excludedWindowIDs = Set<UInt32>()
var listAll = false
var argumentIndex = 1

while argumentIndex < CommandLine.arguments.count {
    let argument = CommandLine.arguments[argumentIndex]
    if argument == "--list" {
        listAll = true
    } else if argument == "--exclude", argumentIndex + 1 < CommandLine.arguments.count {
        argumentIndex += 1
        if let windowID = UInt32(CommandLine.arguments[argumentIndex]) {
            excludedWindowIDs.insert(windowID)
        }
    }
    argumentIndex += 1
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let rawWindows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
var windows: [WindowInfo] = []

for rawWindow in rawWindows {
    guard
        let windowNumber = rawWindow[kCGWindowNumber as String] as? NSNumber,
        let owner = rawWindow[kCGWindowOwnerName as String] as? String,
        let layerNumber = rawWindow[kCGWindowLayer as String] as? NSNumber,
        let alphaNumber = rawWindow[kCGWindowAlpha as String] as? NSNumber,
        let boundsDictionary = rawWindow[kCGWindowBounds as String] as? NSDictionary,
        let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary)
    else {
        continue
    }

    let windowID = windowNumber.uint32Value
    let layer = layerNumber.intValue
    let alpha = alphaNumber.doubleValue

    // Normal application content windows are on layer 0. System overlays,
    // menu extras and the desktop are not valid targets for Daisy vision.
    guard layer == 0, alpha > 0 else { continue }
    guard bounds.width >= 20, bounds.height >= 20 else { continue }
    guard !excludedWindowIDs.contains(windowID) else { continue }

    let sharingState = rawWindow[kCGWindowSharingState as String] as? Int ?? 1
    guard sharingState != 0 else { continue }

    let name = rawWindow[kCGWindowName as String] as? String ?? ""
    windows.append(WindowInfo(
        id: windowID,
        owner: owner,
        name: name,
        layer: layer,
        x: Int(bounds.origin.x.rounded()),
        y: Int(bounds.origin.y.rounded()),
        width: Int(bounds.width.rounded()),
        height: Int(bounds.height.rounded())
    ))
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]

if listAll {
    let data = try encoder.encode(windows)
    FileHandle.standardOutput.write(data)
} else if let firstWindow = windows.first {
    let data = try encoder.encode(firstWindow)
    FileHandle.standardOutput.write(data)
} else {
    FileHandle.standardOutput.write(Data("null".utf8))
}
