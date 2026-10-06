import Foundation
import CryptoKit

/// Downloads the media behind Instagram, TikTok and Pinterest links with
/// yt-dlp, so a link to a post can be shown as the attachments it holds: one
/// video or image, or an album for a multi-item post.
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
final class SocialMediaDownloader {
    static let shared = SocialMediaDownloader()

    enum DownloadError: LocalizedError {
        case install(String)
        case download(String)
        case timedOut(String)
        case http(Int, String)

        var errorDescription: String? {
            switch self {
            case .install(let msg): return "Couldn't install yt-dlp: \(msg)"
            case .download(let msg): return "Couldn't download media: \(msg)"
            case .timedOut(let tool): return "\(tool) timed out"
            case .http(let status, let url): return "HTTP \(status) for \(url)"
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
    // Instagram and Pinterest both cap a post at 20 items.
    private static let maxItems = 20
    // Written last into a post's cache directory, listing its files in order;
    // a directory without it is an interrupted download.
    private static let manifestName = "items.json"

    private let fm = FileManager.default
    private let installDir: URL
    private let cacheDir: URL

    // Callbacks waiting on an in-flight download, keyed by cache key.
    private var waiters: [String: [(Result<[String], Error>) -> Void]] = [:]
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
        cacheDir = URL(fileURLWithPath: "\(home)/Library/Caches/hush/social-media")
        try? fm.createDirectory(at: installDir, withIntermediateDirectories: true)
        try? fm.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        // Videos-only cache from before posts could hold images.
        try? fm.removeItem(atPath: "\(home)/Library/Caches/hush/social-videos")
    }

    /// Resolves with the local paths of the media in the post behind `url`, in
    /// the post's order, downloading them first unless they're already cached.
    /// Concurrent requests for the same post share one download.
    func download(url: String, completion: @escaping (Result<[String], Error>) -> Void) {
        let key = cacheKey(for: url)
        let dir = cacheDir.appendingPathComponent(key)
        if let cached = cachedItems(in: dir) {
            completion(.success(cached))
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
            let result = Result { try self.fetch(url: url, to: dir) }
            self.waitersLock.lock()
            let callbacks = self.waiters.removeValue(forKey: key) ?? []
            self.waitersLock.unlock()
            callbacks.forEach { $0(result) }
        }
    }

    private func cachedItems(in dir: URL) -> [String]? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent(Self.manifestName)),
              let names = try? JSONDecoder().decode([String].self, from: data) else { return nil }
        let paths = names.map { dir.appendingPathComponent($0).path }
        return paths.allSatisfy(fm.fileExists(atPath:)) ? paths : nil
    }

    // MARK: - Downloading

    private func fetch(url: String, to dir: URL) throws -> [String] {
        let target = try resolveShortLink(url)
        let tool = try resolveTool()
        let names: [String]
        do {
            names = try runDownload(tool: tool, url: target, to: dir)
        } catch {
            guard secondsSinceUpdateCheck() > Self.failureUpdateInterval else { throw error }
            NSLog("SocialMediaDownloader: %@ failed (%@), checking for a newer yt-dlp", url, error.localizedDescription)
            guard try update() else { throw error }
            names = try runDownload(tool: try resolveTool(), url: target, to: dir)
        }
        try JSONEncoder().encode(names).write(to: dir.appendingPathComponent(Self.manifestName), options: .atomic)
        return names.map { dir.appendingPathComponent($0).path }
    }

    /// Downloads every item in the post into `dir`, returning their file names
    /// in order.
    ///
    /// yt-dlp only downloads video: an image has no formats, and its full-size
    /// URL is only listed as the entry's thumbnail. So it's asked to write each
    /// entry's info JSON alongside whatever it downloads, and the images are
    /// fetched from those afterwards. A multi-item post is a playlist with one
    /// entry per item.
    private func runDownload(tool: String, url: String, to dir: URL) throws -> [String] {
        let work = fm.temporaryDirectory.appendingPathComponent("hush-ytdlp-\(UUID().uuidString)")
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }

        // No ffmpeg ships with the app, so pick a format that is already a
        // single muxed file rather than separate streams yt-dlp would merge.
        // H.264 MP4 first since AVFoundation plays it everywhere.
        // An image post still "fails" for having no video, so the exit status
        // can't be trusted; what got written says what worked.
        var failure: Error?
        do {
            try run(tool, [
                "--ignore-config",
                "--quiet", "--no-warnings", "--no-progress",
                "--ignore-no-formats-error",
                "--playlist-items", "1:\(Self.maxItems)",
                "--max-filesize", "200M",
                "--socket-timeout", "20",
                "-f", "b[ext=mp4][vcodec^=h264]/b[ext=mp4][vcodec^=avc]/b[ext=mp4]/b*[ext=mp4]",
                "--write-info-json", "--no-write-playlist-metafiles",
                "-o", work.appendingPathComponent("%(playlist_index|1)s.%(ext)s").path,
                url,
            ], timeout: Self.downloadTimeout)
        } catch DownloadError.timedOut(let tool) {
            throw DownloadError.timedOut(tool)
        } catch {
            failure = error
        }

        let entries: [(index: Int, info: [String: Any])] = ((try? fm.contentsOfDirectory(atPath: work.path)) ?? [])
            .compactMap { name in
                guard name.hasSuffix(".info.json"),
                      let index = Int(name.dropLast(".info.json".count)),
                      let data = try? Data(contentsOf: work.appendingPathComponent(name)),
                      let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
                return (index, info)
            }
            .sorted { $0.index < $1.index }
        guard !entries.isEmpty else {
            throw failure ?? DownloadError.download("yt-dlp produced nothing")
        }

        var sources: [Source] = entries.compactMap { entry in
            if let formats = entry.info["formats"] as? [Any], !formats.isEmpty {
                // A video yt-dlp couldn't fetch (too big, no usable format) is
                // left out rather than shown as its still.
                let file = work.appendingPathComponent("\(entry.index).mp4")
                return fm.fileExists(atPath: file.path) ? .file(file) : nil
            }
            guard let image = entry.info["thumbnail"] as? String, let imageURL = URL(string: image) else { return nil }
            return .remote(imageURL, headers: entry.info["http_headers"] as? [String: String] ?? [:])
        }
        if entries.count == 1, case .remote = sources.first,
           entries[0].info["extractor_key"] as? String == "Pinterest",
           let pinID = entries[0].info["id"] as? String,
           let carousel = pinterestCarousel(pinID: pinID) {
            sources = carousel.map { .remote($0, headers: [:]) }
        }
        guard !sources.isEmpty else {
            throw failure ?? DownloadError.download("no usable media in post")
        }

        let staged = try fetchAll(sources, into: work)
        try? fm.removeItem(at: dir)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return try staged.enumerated().map { i, file in
            let name = "\(i + 1).\(file.pathExtension)"
            try fm.moveItem(at: file, to: dir.appendingPathComponent(name))
            return name
        }
    }

    private enum Source {
        case file(URL)
        case remote(URL, headers: [String: String])
    }

    /// Local copies of `sources`, in order, fetching the remote ones together.
    private func fetchAll(_ sources: [Source], into work: URL) throws -> [URL] {
        var results = [Result<URL, Error>?](repeating: nil, count: sources.count)
        let lock = NSLock()
        DispatchQueue.concurrentPerform(iterations: sources.count) { i in
            let result: Result<URL, Error>
            switch sources[i] {
            case .file(let url):
                result = .success(url)
            case .remote(let url, let headers):
                result = Result {
                    let file = try fetchFile(url.absoluteString, headers: headers)
                    let ext = url.pathExtension.isEmpty ? "jpg" : url.pathExtension.lowercased()
                    let dest = work.appendingPathComponent("image-\(i).\(ext)")
                    try fm.moveItem(at: file, to: dest)
                    return dest
                }
            }
            lock.lock()
            results[i] = result
            lock.unlock()
        }
        return try results.map { try $0!.get() }
    }

    /// The full-size images of a Pinterest carousel pin, or nil when it isn't
    /// one. yt-dlp only returns a pin's cover image, so this asks the same
    /// endpoint its extractor uses for the rest.
    private func pinterestCarousel(pinID: String) -> [URL]? {
        let options = ["options": ["field_set_key": "unauth_react_main_pin", "id": pinID]]
        guard let json = try? JSONSerialization.data(withJSONObject: options),
              var comps = URLComponents(string: "https://www.pinterest.com/resource/PinResource/get/") else { return nil }
        comps.queryItems = [URLQueryItem(name: "data", value: String(decoding: json, as: UTF8.self))]
        guard let data = try? fetchData(comps.url!.absoluteString, headers: ["X-Pinterest-PWS-Handler": "www/[username].js"]),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pin = (root["resource_response"] as? [String: Any])?["data"] as? [String: Any],
              let slots = (pin["carousel_data"] as? [String: Any])?["carousel_slots"] as? [[String: Any]],
              slots.count > 1 else { return nil }
        // Slots only list resized copies, but the original sits at the same
        // path under /originals/.
        let urls = slots.prefix(Self.maxItems).compactMap { slot -> URL? in
            guard let images = slot["images"] as? [String: [String: Any]],
                  let best = images.values.max(by: { ($0["width"] as? Int ?? 0) < ($1["width"] as? Int ?? 0) }),
                  let url = best["url"] as? String else { return nil }
            return URL(string: url.replacingOccurrences(of: #"pinimg\.com/[^/]+/"#, with: "pinimg.com/originals/", options: .regularExpression))
        }
        return urls.count == slots.prefix(Self.maxItems).count ? urls : nil
    }

    /// Pinterest's pin.it short links redirect through a /pin/<id>/sent/ page
    /// that bounces logged-out visitors to an error page, so follow them only
    /// as far as the pin.
    private func resolveShortLink(_ url: String) throws -> String {
        guard let parsed = URL(string: url), parsed.host?.lowercased() == "pin.it" else { return url }
        let stopper = PinRedirectStopper()
        let session = URLSession(configuration: .ephemeral, delegate: stopper, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: parsed) { _, _, _ in done.signal() }.resume()
        _ = done.wait(timeout: .now() + 30)
        guard let pinID = stopper.pinID else {
            throw DownloadError.download("pin.it link didn't lead to a pin")
        }
        return "https://www.pinterest.com/pin/\(pinID)/"
    }

    private final class PinRedirectStopper: NSObject, URLSessionTaskDelegate {
        private(set) var pinID: String?

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            let path = request.url?.path ?? ""
            if let match = path.range(of: #"/pin/(?:[\w-]+--)?\d+"#, options: .regularExpression),
               request.url?.host?.contains("pinterest.") == true {
                pinID = String(path[match].reversed().prefix(while: \.isNumber).reversed())
                completionHandler(nil)
            } else {
                completionHandler(request)
            }
        }
    }

    /// Instagram links carry per-share tracking params (`?igsh=…`), so the same
    /// post shared twice would otherwise download twice.
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
                do { try self.update() } catch { NSLog("SocialMediaDownloader: update failed: %@", error.localizedDescription) }
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

        NSLog("SocialMediaDownloader: installing yt-dlp (%@)", expected)
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
            throw DownloadError.timedOut((executable as NSString).lastPathComponent)
        }
        readers.wait()

        guard process.terminationStatus == 0 else {
            let message = String(decoding: err, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw DownloadError.download(message.isEmpty ? "exit \(process.terminationStatus)" : message)
        }
        return String(decoding: out, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func fetchData(_ urlString: String, headers: [String: String] = [:]) throws -> Data {
        let file = try fetchFile(urlString, headers: headers)
        defer { try? fm.removeItem(at: file) }
        return try Data(contentsOf: file)
    }

    private func fetchFile(_ urlString: String, headers: [String: String] = [:]) throws -> URL {
        guard let url = URL(string: urlString) else { throw DownloadError.download("bad URL \(urlString)") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
        let done = DispatchSemaphore(value: 0)
        var result: Result<URL, Error> = .failure(DownloadError.download("no response from \(urlString)"))
        URLSession.shared.downloadTask(with: request) { location, response, error in
            if let error = error {
                result = .failure(error)
            } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                result = .failure(DownloadError.http(http.statusCode, urlString))
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
