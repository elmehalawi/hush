import Foundation
import CryptoKit

/// Downloads Instagram and TikTok videos with yt-dlp, so a link to one can be
/// shown as an ordinary video attachment.
///
/// yt-dlp isn't bundled. The single-file macOS build re-extracts itself on every
/// run and takes ~10s just to print its version; only the unpacked "onedir"
/// build starts fast, and that is ~120MB — most of the app again. Its site
/// extractors also break often enough that a copy frozen at release time would
/// stop working between releases. So the official build is fetched on first use
/// and kept current.
///
/// A yt-dlp already on the machine (e.g. from Homebrew) is deliberately not
/// used: we can't update it, and a three-month-old copy was enough for
/// Instagram to reject every download as "login required".
final class SocialVideoDownloader {
    static let shared = SocialVideoDownloader()

    enum DownloadError: LocalizedError {
        case install(String)
        case download(String)

        var errorDescription: String? {
            switch self {
            case .install(let msg): return "Couldn't install yt-dlp: \(msg)"
            case .download(let msg): return "Couldn't download video: \(msg)"
            }
        }
    }

    private static let releaseBase = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/"
    private static let releaseAsset = "yt-dlp_macos.zip"
    private static let updateInterval: TimeInterval = 7 * 24 * 3600
    // A failed download may mean an extractor broke upstream, so it may pull a
    // fresh yt-dlp — but not more often than this.
    private static let failureUpdateInterval: TimeInterval = 3600
    private static let downloadTimeout: TimeInterval = 180

    private let fm = FileManager.default
    private let installDir: URL
    private let cacheDir: URL

    // Callbacks waiting on an in-flight download, keyed by cache key.
    private var waiters: [String: [(Result<String, Error>) -> Void]] = [:]
    private let waitersLock = NSLock()
    // Opening a chat with a long history can surface many links at once.
    private let downloads: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 2
        q.qualityOfService = .userInitiated
        return q
    }()
    private let installLock = NSLock()

    private init() {
        let home = NSHomeDirectory()
        installDir = URL(fileURLWithPath: "\(home)/Library/Application Support/hush/yt-dlp")
        cacheDir = URL(fileURLWithPath: "\(home)/Library/Caches/hush/social-videos")
        try? fm.createDirectory(at: installDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: cacheDir, withIntermediateDirectories: true)
    }

    /// Resolves with the local path of the video behind `url`, downloading it
    /// first unless it's already cached. Concurrent requests for the same video
    /// share one download.
    func download(url: String, completion: @escaping (Result<String, Error>) -> Void) {
        let key = cacheKey(for: url)
        let dest = cacheDir.appendingPathComponent("\(key).mp4")
        if fm.fileExists(atPath: dest.path) {
            completion(.success(dest.path))
            return
        }

        waitersLock.lock()
        if waiters[key] != nil {
            waiters[key]!.append(completion)
            waitersLock.unlock()
            return
        }
        waiters[key] = [completion]
        waitersLock.unlock()

        downloads.addOperation {
            let result = Result { try self.fetch(url: url, to: dest) }
            self.waitersLock.lock()
            let callbacks = self.waiters.removeValue(forKey: key) ?? []
            self.waitersLock.unlock()
            callbacks.forEach { $0(result) }
        }
    }

    // MARK: - Downloading

    private func fetch(url: String, to dest: URL) throws -> String {
        let tool = try resolveTool()
        do {
            try runDownload(tool: tool, url: url, to: dest)
        } catch {
            guard secondsSinceUpdateCheck() > Self.failureUpdateInterval else { throw error }
            NSLog("SocialVideoDownloader: %@ failed (%@), checking for a newer yt-dlp", url, error.localizedDescription)
            guard try update() else { throw error }
            try runDownload(tool: try resolveTool(), url: url, to: dest)
        }
        return dest.path
    }

    private func runDownload(tool: String, url: String, to dest: URL) throws {
        let work = fm.temporaryDirectory.appendingPathComponent("hush-ytdlp-\(UUID().uuidString)")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }

        // No ffmpeg ships with the app, so pick a format that is already a
        // single muxed file rather than separate streams yt-dlp would merge.
        // H.264 MP4 first since AVFoundation plays it everywhere.
        let output = try run(tool, [
            "--ignore-config",
            "--quiet", "--no-warnings", "--no-progress",
            "--playlist-items", "1",
            "--max-filesize", "200M",
            "--socket-timeout", "20",
            "-f", "b[ext=mp4][vcodec^=h264]/b[ext=mp4][vcodec^=avc]/b[ext=mp4]/b*[ext=mp4]",
            "-o", work.appendingPathComponent("video.%(ext)s").path,
            "--print", "after_move:filepath",
            url,
        ], timeout: Self.downloadTimeout)

        guard let path = output.split(separator: "\n").last.map(String.init),
              fm.fileExists(atPath: path) else {
            throw DownloadError.download("yt-dlp produced no file")
        }
        try? fm.removeItem(at: dest)
        try fm.moveItem(atPath: path, toPath: dest.path)
    }

    /// Instagram links carry per-share tracking params (`?igsh=…`), so the same
    /// reel shared twice would otherwise download twice.
    private func cacheKey(for url: String) -> String {
        var normalized = url
        if var comps = URLComponents(string: url) {
            comps.query = nil
            comps.fragment = nil
            comps.host = comps.host?.lowercased().replacingOccurrences(of: "www.", with: "")
            if comps.path.hasSuffix("/") { comps.path.removeLast() }
            normalized = comps.string ?? url
        }
        return SHA256.hash(data: Data(normalized.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Locating / installing yt-dlp

    private var managedBinary: URL { installDir.appendingPathComponent("current/yt-dlp_macos") }
    private var checkStamp: URL { installDir.appendingPathComponent("last-update-check") }
    private var installedHashFile: URL { installDir.appendingPathComponent("current/.zip-sha256") }

    /// The path of our yt-dlp, installing it first if needed.
    private func resolveTool() throws -> String {
        if !fm.isExecutableFile(atPath: managedBinary.path) {
            try update()
        } else if secondsSinceUpdateCheck() > Self.updateInterval {
            DispatchQueue.global(qos: .utility).async {
                do { try self.update() } catch { NSLog("SocialVideoDownloader: update failed: %@", error.localizedDescription) }
            }
        }
        return managedBinary.path
    }

    private func secondsSinceUpdateCheck() -> TimeInterval {
        let modified = (try? fm.attributesOfItem(atPath: checkStamp.path)[.modificationDate]) as? Date
        return modified.map { Date().timeIntervalSince($0) } ?? .infinity
    }

    /// Installs the latest official build unless it's the one already
    /// installed, returning whether it installed anything. The release's
    /// checksum doubles as its version.
    @discardableResult
    private func update() throws -> Bool {
        installLock.lock()
        defer { installLock.unlock() }

        let sums = try String(decoding: fetchData(Self.releaseBase + "SHA2-256SUMS"), as: UTF8.self)
        guard let expected = sums.split(separator: "\n")
            .map({ $0.split(separator: " ", omittingEmptySubsequences: true) })
            .first(where: { $0.last == Substring(Self.releaseAsset) })?.first.map(String.init) else {
            throw DownloadError.install("no checksum for \(Self.releaseAsset)")
        }
        defer { fm.createFile(atPath: checkStamp.path, contents: nil) }

        if (try? String(contentsOf: installedHashFile, encoding: .utf8)) == expected,
           fm.isExecutableFile(atPath: managedBinary.path) {
            return false
        }

        NSLog("SocialVideoDownloader: installing yt-dlp (%@)", expected)
        let zip = try fetchFile(Self.releaseBase + Self.releaseAsset)
        defer { try? fm.removeItem(at: zip) }

        let actual = SHA256.hash(data: try Data(contentsOf: zip, options: .mappedIfSafe))
            .map { String(format: "%02x", $0) }.joined()
        guard actual == expected else {
            throw DownloadError.install("checksum mismatch")
        }

        // Unpack beside the live copy and swap the `current` symlink, so a
        // download already running from the old copy isn't pulled out from
        // under it.
        let versionDir = installDir.appendingPathComponent("\(expected.prefix(12))-\(Int(Date().timeIntervalSince1970))")
        _ = try run("/usr/bin/ditto", ["-x", "-k", zip.path, versionDir.path], timeout: 120)
        try expected.write(to: versionDir.appendingPathComponent(".zip-sha256"), atomically: true, encoding: .utf8)
        _ = try run(versionDir.appendingPathComponent("yt-dlp_macos").path, ["--version"], timeout: 60)

        let current = installDir.appendingPathComponent("current")
        let previous = try? fm.destinationOfSymbolicLink(atPath: current.path)
        let staged = installDir.appendingPathComponent("current.new")
        try? fm.removeItem(at: staged)
        try fm.createSymbolicLink(atPath: staged.path, withDestinationPath: versionDir.lastPathComponent)
        guard rename(staged.path, current.path) == 0 else {
            throw DownloadError.install("couldn't activate new version")
        }

        // Everything older than the copy just replaced is no longer in use.
        let keep: Set<String> = [versionDir.lastPathComponent, previous ?? "", "current", checkStamp.lastPathComponent]
        for name in (try? fm.contentsOfDirectory(atPath: installDir.path)) ?? [] where !keep.contains(name) {
            try? fm.removeItem(at: installDir.appendingPathComponent(name))
        }
        return true
    }

    // MARK: - Helpers

    @discardableResult
    private func run(_ executable: String, _ args: [String], timeout: TimeInterval) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = FileHandle.nullDevice

        let exited = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in exited.signal() }
        try process.run()

        // Drain both pipes while it runs; a full pipe buffer would stall it.
        var out = Data()
        var err = Data()
        let readers = DispatchGroup()
        DispatchQueue.global().async(group: readers) { out = stdout.fileHandleForReading.readDataToEndOfFile() }
        DispatchQueue.global().async(group: readers) { err = stderr.fileHandleForReading.readDataToEndOfFile() }

        if exited.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            exited.wait()
            readers.wait()
            throw DownloadError.download("\((executable as NSString).lastPathComponent) timed out")
        }
        readers.wait()

        guard process.terminationStatus == 0 else {
            let message = String(decoding: err, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw DownloadError.download(message.isEmpty ? "exit \(process.terminationStatus)" : message)
        }
        return String(decoding: out, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func fetchData(_ urlString: String) throws -> Data {
        let file = try fetchFile(urlString)
        defer { try? fm.removeItem(at: file) }
        return try Data(contentsOf: file)
    }

    private func fetchFile(_ urlString: String) throws -> URL {
        var request = URLRequest(url: URL(string: urlString)!)
        request.timeoutInterval = 60
        let done = DispatchSemaphore(value: 0)
        var result: Result<URL, Error> = .failure(DownloadError.install("no response"))
        URLSession.shared.downloadTask(with: request) { location, response, error in
            if let error = error {
                result = .failure(error)
            } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                result = .failure(DownloadError.install("HTTP \(http.statusCode) for \(urlString)"))
            } else if let location = location {
                // The system deletes `location` once this handler returns.
                let kept = self.fm.temporaryDirectory.appendingPathComponent("hush-\(UUID().uuidString)")
                result = Result { try self.fm.moveItem(at: location, to: kept); return kept }
            }
            done.signal()
        }.resume()
        done.wait()
        return try result.get()
    }
}
