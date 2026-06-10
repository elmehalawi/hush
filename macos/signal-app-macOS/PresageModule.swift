import Foundation
import Contacts
import AVFoundation
import AppKit
import AVKit
import UserNotifications
import Intents

@objc(PresageModule)
class PresageModule: RCTEventEmitter {

    private var client: SignalClient?
    private var hasListeners = false

    // Queue for events that arrive before listeners are ready
    private var pendingQrCodeUrl: String?
    private var currentQrCodeUrl: String?  // Always stores the current QR URL for polling
    private let queueLock = NSLock()

    // Audio playback
    private var audioPlayer: AVAudioPlayer?
    private var audioProgressTimer: Timer?
    private var currentAudioFilePath: String?

    // Notifications
    private var notificationsAuthorized = false
    private var channelNameCache: [String: String] = [:]
    private var channelIsGroupCache: [String: Bool] = [:]
    private var channelAvatarCache: [String: String] = [:]
    private let avatarCacheLock = NSLock()

    override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleOpenSessions),
            name: NSNotification.Name("OpenSessionsSettings"),
            object: nil
        )
    }

    @objc private func handleOpenSessions() {
        sendEventIfListening("onOpenSessions", body: nil)
    }

    @objc override static func requiresMainQueueSetup() -> Bool {
        return false
    }

    override func supportedEvents() -> [String]! {
        return ["onMessage", "onReaction", "onReadReceipt", "onChannelUpdated", "onAttachmentDownloaded", "onLinkingQrCode", "onLinkingComplete", "onError", "onNotificationClicked", "onPasteFiles", "onAudioProgress", "onAudioComplete", "onOpenSessions"]
    }

    override func startObserving() {
        NSLog("PresageModule: startObserving called - JS listeners are now ready")
        hasListeners = true

        // Send any pending QR code that arrived before listeners were ready
        queueLock.lock()
        if let pendingUrl = pendingQrCodeUrl {
            NSLog("PresageModule: Sending pending QR code URL (length=%d)", pendingUrl.count)
            pendingQrCodeUrl = nil
            queueLock.unlock()
            sendEvent(withName: "onLinkingQrCode", body: ["url": pendingUrl])
        } else {
            queueLock.unlock()
        }
    }

    override func stopObserving() {
        NSLog("PresageModule: stopObserving called")
        hasListeners = false
    }

    private func sendEventIfListening(_ name: String, body: Any?) {
        NSLog("PresageModule: sendEventIfListening - name: %@, hasListeners: %@", name, hasListeners ? "true" : "false")

        // Special handling for QR code - queue it if listeners aren't ready
        if name == "onLinkingQrCode" && !hasListeners {
            if let dict = body as? [String: String], let url = dict["url"] {
                NSLog("PresageModule: Queueing QR code URL for later (listeners not ready)")
                queueLock.lock()
                pendingQrCodeUrl = url
                queueLock.unlock()
                return
            }
        }

        sendEvent(withName: name, body: body)
    }

    // MARK: - Exported Methods

    @objc(initialize:rejecter:)
    func initialize(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let home = NSHomeDirectory()
                let dataDir = "\(home)/Library/Application Support/hush"
                NSLog("PresageModule: initializing with dataDir: \(dataDir)")

                // Create the directory if it doesn't exist
                let fileManager = FileManager.default
                if !fileManager.fileExists(atPath: dataDir) {
                    NSLog("PresageModule: creating directory: \(dataDir)")
                    try fileManager.createDirectory(atPath: dataDir, withIntermediateDirectories: true, attributes: nil)
                }

                // Verify directory exists and is writable
                var isDir: ObjCBool = false
                if fileManager.fileExists(atPath: dataDir, isDirectory: &isDir) && isDir.boolValue {
                    NSLog("PresageModule: directory exists, isWritable: \(fileManager.isWritableFile(atPath: dataDir))")
                } else {
                    NSLog("PresageModule: ERROR - directory does not exist after creation attempt")
                }

                self.client = try SignalClient(dataDir: dataDir)
                NSLog("PresageModule: SignalClient created successfully")

                // Request notification permissions
                let center = UNUserNotificationCenter.current()
                center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                    NSLog("PresageModule: Notification authorization granted: \(granted)")
                    self.notificationsAuthorized = granted
                }
                let handler = NotificationDelegateHandler.shared
                handler.presageModule = self
                center.delegate = handler

                resolver(nil)
            } catch {
                NSLog("PresageModule: ERROR - \(error)")
                rejecter("INIT_ERROR", "Failed to initialize SignalClient: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(isLinked:rejecter:)
    func isLinked(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }
        resolver(client.isLinked())
    }

    // Get the current QR code URL (for polling fallback if events don't work)
    @objc(getCurrentQrCodeUrl:rejecter:)
    func getCurrentQrCodeUrl(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        queueLock.lock()
        let url = currentQrCodeUrl
        queueLock.unlock()
        resolver(url)
    }

    @objc(getUserId:rejecter:)
    func getUserId(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }
        do {
            let userId = try client.getUserId()
            resolver(userId)
        } catch {
            rejecter("GET_USER_ID_ERROR", "Failed to get user ID: \(error.localizedDescription)", error)
        }
    }

    @objc(startLinking:resolver:rejecter:)
    func startLinking(_ deviceName: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        NSLog("PresageModule: startLinking called with deviceName: \(deviceName)")

        guard let client = client else {
            NSLog("PresageModule: ERROR - Client not initialized")
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        NSLog("PresageModule: Creating LinkingCallbackImpl")
        let callback = LinkingCallbackImpl(
            onQrCode: { [weak self] url in
                NSLog("PresageModule: onQrCode callback received URL (length=%d)", url.count)
                // Store the URL for polling fallback
                self?.queueLock.lock()
                self?.currentQrCodeUrl = url
                self?.queueLock.unlock()
                self?.sendEventIfListening("onLinkingQrCode", body: ["url": url])
            },
            onComplete: { [weak self] in
                NSLog("PresageModule: onComplete callback received")
                self?.sendEventIfListening("onLinkingComplete", body: nil)
            },
            onError: { [weak self] error in
                NSLog("PresageModule: onError callback received: \(error)")
                self?.sendEventIfListening("onError", body: ["message": error])
            }
        )

        NSLog("PresageModule: Dispatching startLinking to background queue")
        DispatchQueue.global(qos: .userInitiated).async {
            NSLog("PresageModule: In background queue, calling client.startLinking")
            do {
                try client.startLinking(deviceName: deviceName, callback: callback)
                NSLog("PresageModule: startLinking completed successfully")
                resolver(nil)
            } catch {
                NSLog("PresageModule: startLinking failed with error: \(error)")
                rejecter("LINKING_ERROR", "Failed to start linking: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(getChannels:rejecter:)
    func getChannels(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let channels = try client.getChannels()
                let channelDicts = channels.map { channel -> [String: Any?] in
                    var dict = self.channelToDict(channel)
                    // Cache channel name and avatar for notifications
                    self.avatarCacheLock.lock()
                    self.channelNameCache[channel.id] = channel.name
                    self.channelIsGroupCache[channel.id] = channel.isGroup
                    if let avatarPath = channel.avatarPath {
                        self.channelAvatarCache[channel.id] = avatarPath
                    }
                    self.avatarCacheLock.unlock()
                    // For contacts without a Signal profile picture, try macOS Contacts
                    if channel.avatarPath == nil && !channel.isGroup {
                        if let path = self.findContactPhoto(phoneNumber: channel.phoneNumber, name: channel.name, channelId: channel.id) {
                            dict["avatarPath"] = path
                            // Also cache the macOS Contacts avatar
                            self.avatarCacheLock.lock()
                            self.channelAvatarCache[channel.id] = path
                            self.avatarCacheLock.unlock()
                        }
                    }
                    return dict
                }
                resolver(channelDicts)
            } catch {
                rejecter("GET_CHANNELS_ERROR", "Failed to get channels: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(getMessages:limit:resolver:rejecter:)
    func getMessages(_ channelId: String, limit: UInt32, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let messages = try client.getMessages(channelId: channelId, limit: limit)
                let messageDicts = messages.map { self.messageToDict($0) }
                resolver(messageDicts)
            } catch {
                rejecter("GET_MESSAGES_ERROR", "Failed to get messages: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(sendMessage:text:resolver:rejecter:)
    func sendMessage(_ channelId: String, text: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let message = try client.sendMessage(channelId: channelId, text: text)
                resolver(self.messageToDict(message))
            } catch {
                rejecter("SEND_ERROR", "Failed to send message: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(sendReaction:emoji:targetTimestamp:remove:resolver:rejecter:)
    func sendReaction(_ channelId: String, emoji: String, targetTimestamp: Double, remove: Bool, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try client.sendReaction(channelId: channelId, emoji: emoji, targetTimestamp: UInt64(targetTimestamp), remove: remove)
                resolver(nil)
            } catch {
                rejecter("SEND_REACTION_ERROR", "Failed to send reaction: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(startReceiving:rejecter:)
    func startReceiving(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        let listener = MessageListenerImpl(
            onMessage: { [weak self] message in
                self?.sendEventIfListening("onMessage", body: self?.messageToDict(message))
                self?.postNotification(for: message)
            },
            onReaction: { [weak self] reaction in
                self?.sendEventIfListening("onReaction", body: self?.reactionEventToDict(reaction))
            },
            onReadReceipt: { [weak self] senderId, timestamps in
                self?.sendEventIfListening("onReadReceipt", body: [
                    "senderId": senderId,
                    "timestamps": timestamps.map { NSNumber(value: $0) }
                ])
            },
            onChannelUpdated: { [weak self] channel in
                self?.avatarCacheLock.lock()
                if !channel.name.isEmpty {
                    self?.channelNameCache[channel.id] = channel.name
                }
                self?.channelIsGroupCache[channel.id] = channel.isGroup
                if let avatarPath = channel.avatarPath {
                    self?.channelAvatarCache[channel.id] = avatarPath
                }
                self?.avatarCacheLock.unlock()
                self?.sendEventIfListening("onChannelUpdated", body: self?.channelToDict(channel))
            },
            onError: { [weak self] error in
                self?.sendEventIfListening("onError", body: ["message": error])
            },
            onAttachmentDownloaded: { [weak self] channelId, messageId, attachmentIndex, attachment in
                guard let self = self else { return }
                var body: [String: Any] = [
                    "channelId": channelId,
                    "messageId": messageId,
                    "attachmentIndex": NSNumber(value: attachmentIndex),
                ]
                body["attachment"] = self.attachmentToDict(attachment)
                self.sendEventIfListening("onAttachmentDownloaded", body: body)
            }
        )

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try client.startReceiving(listener: listener)
                resolver(nil)
            } catch {
                rejecter("RECEIVE_ERROR", "Failed to start receiving: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(stopReceiving:rejecter:)
    func stopReceiving(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }
        client.stopReceiving()
        resolver(nil)
    }

    @objc(retryDownload:messageId:attachmentIndex:resolver:rejecter:)
    func retryDownload(_ channelId: String, messageId: String, attachmentIndex: UInt32, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try client.retryDownload(channelId: channelId, messageId: messageId, attachmentIndex: attachmentIndex)
                resolver(nil)
            } catch {
                rejecter("RETRY_ERROR", "Failed to retry download: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(markAsRead:upToTimestamp:senderUuid:timestamps:resolver:rejecter:)
    func markAsRead(_ channelId: String, upToTimestamp: Double, senderUuid: String, timestamps: [Double], resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                // Update read state
                try client.markAsRead(channelId: channelId, upToTimestamp: UInt64(upToTimestamp))

                // Send read receipt to the sender (best-effort)
                if !senderUuid.isEmpty {
                    let ts = timestamps.map { UInt64($0) }
                    do {
                        try client.sendReadReceipt(senderUuid: senderUuid, timestamps: ts)
                    } catch {
                        NSLog("PresageModule: Failed to send read receipt: \(error)")
                    }
                }

                resolver(nil)
            } catch {
                rejecter("MARK_READ_ERROR", "Failed to mark as read: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(getAllSessions:rejecter:)
    func getAllSessions(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let sessions = try client.getAllSessions()
                let dicts = sessions.map { session -> [String: Any?] in
                    return [
                        "address": session.address,
                        "deviceCount": session.deviceCount,
                        "contactName": session.contactName,
                    ]
                }
                resolver(dicts)
            } catch {
                rejecter("GET_SESSIONS_ERROR", "Failed to get sessions: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(resetSession:resolver:rejecter:)
    func resetSession(_ channelId: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try client.resetSession(channelId: channelId)
                NSLog("PresageModule: Session reset completed for %@", channelId)
                resolver(nil)
            } catch {
                NSLog("PresageModule: Session reset failed: %@", error.localizedDescription)
                rejecter("RESET_SESSION_ERROR", "Failed to reset session: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(fetchAllAvatars:rejecter:)
    func fetchAllAvatars(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .utility).async {
            do {
                try client.fetchAllAvatars()
                resolver(nil)
            } catch {
                rejecter("AVATAR_ERROR", "Failed to fetch avatars: \(error.localizedDescription)", error)
            }
        }
    }

    // MARK: - Attachment Sending

    @objc(sendMessageWithAttachments:text:attachmentPaths:resolver:rejecter:)
    func sendMessageWithAttachments(_ channelId: String, text: String?, attachmentPaths: [String], resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let message = try client.sendMessageWithAttachments(
                    channelId: channelId,
                    text: text,
                    attachmentPaths: attachmentPaths
                )
                resolver(self.messageToDict(message))
            } catch {
                rejecter("SEND_ERROR", "Failed to send message with attachments: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(getFileIcon:resolver:rejecter:)
    func getFileIcon(_ filePath: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .userInitiated).async {
            let icon = NSWorkspace.shared.icon(forFile: filePath)
            let size = NSSize(width: 80, height: 80)
            icon.size = size

            guard let tiffData = icon.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiffData),
                  let pngData = rep.representation(using: .png, properties: [:]) else {
                rejecter("ICON_ERROR", "Failed to render file icon", nil)
                return
            }

            let tmpDir = NSTemporaryDirectory()
            let fileName = (filePath as NSString).lastPathComponent
            let iconPath = "\(tmpDir)icon_\(fileName).png"
            do {
                try pngData.write(to: URL(fileURLWithPath: iconPath))
                resolver(iconPath)
            } catch {
                rejecter("ICON_ERROR", "Failed to write icon: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(getClipboardFiles:rejecter:)
    func getClipboardFiles(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            let pasteboard = NSPasteboard.general
            if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
                let paths = urls.map { $0.path }
                resolver(paths)
            } else {
                resolver([])
            }
        }
    }

    @objc(getClipboardImage:rejecter:)
    func getClipboardImage(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            let pasteboard = NSPasteboard.general
            guard let image = NSImage(pasteboard: pasteboard) else {
                resolver(nil)
                return
            }

            guard let tiffData = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiffData),
                  let pngData = rep.representation(using: .png, properties: [:]) else {
                resolver(nil)
                return
            }

            let tmpDir = NSTemporaryDirectory()
            let fileName = "clipboard_\(Int(Date().timeIntervalSince1970 * 1000)).png"
            let filePath = "\(tmpDir)\(fileName)"
            do {
                try pngData.write(to: URL(fileURLWithPath: filePath))
                resolver(filePath)
            } catch {
                resolver(nil)
            }
        }
    }

    @objc(pickFiles:rejecter:)
    func pickFiles(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        NSLog("PresageModule: pickFiles called")
        DispatchQueue.main.async {
            NSLog("PresageModule: showing NSOpenPanel")
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = true
            panel.canChooseFiles = true
            panel.canChooseDirectories = false

            let response = panel.runModal()
            NSLog("PresageModule: NSOpenPanel closed with response: %d", response.rawValue)
            if response == .OK {
                let paths = panel.urls.map { $0.path }
                NSLog("PresageModule: pickFiles returning %d paths: %@", paths.count, paths.description)
                resolver(paths)
            } else {
                NSLog("PresageModule: pickFiles cancelled")
                resolver([])
            }
        }
    }

    @objc(generateVideoThumbnailAtPath:resolver:rejecter:)
    func generateVideoThumbnailAtPath(_ videoPath: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .userInitiated).async {
            resolver(self.generateVideoThumbnail(videoPath: videoPath))
        }
    }

    @objc(generateImageThumbnail:resolver:rejecter:)
    func generateImageThumbnail(_ imagePath: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .userInitiated).async {
            let thumbPath = NSTemporaryDirectory() + "thumb_" + ((imagePath as NSString).lastPathComponent as NSString).deletingPathExtension + ".jpg"
            if FileManager.default.fileExists(atPath: thumbPath) {
                resolver(thumbPath)
                return
            }

            let url = URL(fileURLWithPath: imagePath)
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
                resolver(imagePath)
                return
            }

            let options: [CFString: Any] = [
                kCGImageSourceThumbnailMaxPixelSize: 144,
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
            ]
            guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
                resolver(imagePath)
                return
            }

            let rep = NSBitmapImageRep(cgImage: cgImage)
            guard let jpegData = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
                resolver(imagePath)
                return
            }

            do {
                try jpegData.write(to: URL(fileURLWithPath: thumbPath))
                resolver(thumbPath)
            } catch {
                resolver(imagePath)
            }
        }
    }

    // MARK: - Audio Playback

    @objc(playAudio:resolver:rejecter:)
    func playAudio(_ filePath: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            // If a different file is playing, stop it first
            if let currentPath = self.currentAudioFilePath, currentPath != filePath {
                self.stopAudioInternal()
                self.sendEventIfListening("onAudioComplete", body: ["filePath": currentPath])
            }

            // If same file and player exists, toggle resume
            if let player = self.audioPlayer, self.currentAudioFilePath == filePath {
                player.play()
                self.startProgressTimer()
                resolver(["duration": player.duration, "currentTime": player.currentTime])
                return
            }

            // Create new player
            let url = URL(fileURLWithPath: filePath)
            do {
                let player = try AVAudioPlayer(contentsOf: url)
                player.delegate = AudioPlayerDelegateProxy.shared
                AudioPlayerDelegateProxy.shared.presageModule = self
                player.play()
                self.audioPlayer = player
                self.currentAudioFilePath = filePath
                self.startProgressTimer()
                resolver(["duration": player.duration, "currentTime": player.currentTime])
            } catch {
                rejecter("AUDIO_ERROR", "Failed to play audio: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(pauseAudio:rejecter:)
    func pauseAudio(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            self.audioPlayer?.pause()
            self.audioProgressTimer?.invalidate()
            self.audioProgressTimer = nil
            resolver(nil)
        }
    }

    @objc(stopAudio:rejecter:)
    func stopAudio(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            if let path = self.currentAudioFilePath {
                self.stopAudioInternal()
                self.sendEventIfListening("onAudioComplete", body: ["filePath": path])
            }
            resolver(nil)
        }
    }

    @objc(seekAudio:resolver:rejecter:)
    func seekAudio(_ position: Double, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.main.async {
            guard let player = self.audioPlayer else {
                resolver(nil)
                return
            }
            player.currentTime = position * player.duration
            resolver(["currentTime": player.currentTime, "duration": player.duration])
        }
    }

    @objc(getAudioDuration:resolver:rejecter:)
    func getAudioDuration(_ filePath: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .userInitiated).async {
            let url = URL(fileURLWithPath: filePath)
            do {
                let player = try AVAudioPlayer(contentsOf: url)
                resolver(player.duration)
            } catch {
                rejecter("AUDIO_ERROR", "Failed to get audio duration: \(error.localizedDescription)", error)
            }
        }
    }

    private func startProgressTimer() {
        audioProgressTimer?.invalidate()
        audioProgressTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self = self, let player = self.audioPlayer, let path = self.currentAudioFilePath else { return }
            self.sendEventIfListening("onAudioProgress", body: [
                "currentTime": player.currentTime,
                "duration": player.duration,
                "filePath": path,
            ])
        }
    }

    private func stopAudioInternal() {
        audioPlayer?.stop()
        audioPlayer = nil
        audioProgressTimer?.invalidate()
        audioProgressTimer = nil
        currentAudioFilePath = nil
    }

    func audioDidFinishPlaying() {
        DispatchQueue.main.async {
            if let path = self.currentAudioFilePath {
                self.sendEventIfListening("onAudioComplete", body: ["filePath": path])
            }
            self.stopAudioInternal()
        }
    }

    // MARK: - Channel Context Menu

    @objc(showChannelContextMenu:isGroup:)
    func showChannelContextMenu(_ channelId: String, isGroup: Bool) {
        DispatchQueue.main.async {
            let menu = NSMenu()

            if !isGroup {
                let resetItem = NSMenuItem(title: "Reset Session", action: #selector(self.handleResetSession(_:)), keyEquivalent: "")
                resetItem.representedObject = channelId
                resetItem.target = self
                menu.addItem(resetItem)
            }

            guard !menu.items.isEmpty else { return }
            guard let window = NSApp.keyWindow, let contentView = window.contentView else { return }
            let mouseInWindow = window.mouseLocationOutsideOfEventStream
            let mouseInView = contentView.convert(mouseInWindow, from: nil)
            menu.popUp(positioning: nil, at: mouseInView, in: contentView)
        }
    }

    @objc private func handleResetSession(_ sender: NSMenuItem) {
        guard let channelId = sender.representedObject as? String,
              let client = client else { return }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try client.resetSession(channelId: channelId)
                NSLog("PresageModule: Session reset completed for %@", channelId)
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Session Reset"
                    alert.informativeText = "Encryption session has been reset. New messages should now decrypt correctly."
                    alert.alertStyle = .informational
                    alert.addButton(withTitle: "OK")
                    alert.runModal()
                }
            } catch {
                NSLog("PresageModule: Session reset failed: %@", error.localizedDescription)
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Session Reset Failed"
                    alert.informativeText = error.localizedDescription
                    alert.alertStyle = .warning
                    alert.addButton(withTitle: "OK")
                    alert.runModal()
                }
            }
        }
    }

    // MARK: - Message Context Menu

    @objc(showMessageContextMenu:)
    func showMessageContextMenu(_ messageBody: String) {
        DispatchQueue.main.async {
            let menu = NSMenu()

            let copyItem = NSMenuItem(title: "Copy", action: #selector(self.handleCopyMessageText(_:)), keyEquivalent: "")
            copyItem.representedObject = messageBody
            copyItem.target = self
            menu.addItem(copyItem)

            guard let window = NSApp.keyWindow, let contentView = window.contentView else { return }
            let mouseInWindow = window.mouseLocationOutsideOfEventStream
            let mouseInView = contentView.convert(mouseInWindow, from: nil)
            menu.popUp(positioning: nil, at: mouseInView, in: contentView)
        }
    }

    @objc private func handleCopyMessageText(_ sender: NSMenuItem) {
        guard let text = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    // MARK: - File Context Menu

    @objc(showFileContextMenu:fileName:)
    func showFileContextMenu(_ filePath: String, fileName: String) {
        DispatchQueue.main.async {
            let menu = NSMenu()

            let saveItem = NSMenuItem(title: "Save to Downloads", action: #selector(self.handleSaveToDownloads(_:)), keyEquivalent: "")
            saveItem.representedObject = filePath
            saveItem.target = self
            menu.addItem(saveItem)

            let openItem = NSMenuItem(title: "Open", action: #selector(self.handleOpenFile(_:)), keyEquivalent: "")
            openItem.representedObject = filePath
            openItem.target = self
            menu.addItem(openItem)

            guard let window = NSApp.keyWindow, let contentView = window.contentView else { return }
            let mouseInWindow = window.mouseLocationOutsideOfEventStream
            let mouseInView = contentView.convert(mouseInWindow, from: nil)
            menu.popUp(positioning: nil, at: mouseInView, in: contentView)
        }
    }

    @objc private func handleSaveToDownloads(_ sender: NSMenuItem) {
        guard let filePath = sender.representedObject as? String else { return }
        let fileManager = FileManager.default
        guard let downloadsURL = fileManager.urls(for: .downloadsDirectory, in: .userDomainMask).first else { return }
        let fileName = (filePath as NSString).lastPathComponent
        let nameWithoutExt = (fileName as NSString).deletingPathExtension
        let ext = (fileName as NSString).pathExtension

        var destURL = downloadsURL.appendingPathComponent(fileName)
        var counter = 1
        while fileManager.fileExists(atPath: destURL.path) {
            counter += 1
            let newName = ext.isEmpty ? "\(nameWithoutExt) (\(counter))" : "\(nameWithoutExt) (\(counter)).\(ext)"
            destURL = downloadsURL.appendingPathComponent(newName)
        }

        do {
            try fileManager.copyItem(atPath: filePath, toPath: destURL.path)
            NSLog("PresageModule: Saved file to %@", destURL.path)
        } catch {
            NSLog("PresageModule: Failed to save to downloads: %@", error.localizedDescription)
        }
    }

    @objc private func handleOpenFile(_ sender: NSMenuItem) {
        guard let filePath = sender.representedObject as? String else { return }
        self.mediaPreviewPanel.previewFile(path: filePath)
    }

    // MARK: - Media Preview

    private let mediaPreviewPanel = MediaPreviewPanel()

    @objc(previewFile:)
    func previewFile(_ filePath: String) {
        DispatchQueue.main.async {
            self.mediaPreviewPanel.previewFile(path: filePath)
        }
    }

    // MARK: - macOS Contacts Integration

    private lazy var contactStore = CNContactStore()
    private var contactsAccessGranted: Bool?

    /// Look up a contact photo from macOS Contacts by phone number (preferred) or name (fallback).
    /// Writes the image to the avatars directory and returns the file path.
    private func findContactPhoto(phoneNumber: String?, name: String, channelId: String) -> String? {
        // Check / request access on first call
        if contactsAccessGranted == nil {
            let semaphore = DispatchSemaphore(value: 0)
            contactStore.requestAccess(for: .contacts) { granted, _ in
                self.contactsAccessGranted = granted
                semaphore.signal()
            }
            semaphore.wait()
        }
        guard contactsAccessGranted == true else { return nil }

        let home = NSHomeDirectory()
        let avatarsDir = "\(home)/Library/Application Support/hush/avatars"
        let filePath = "\(avatarsDir)/\(channelId)"

        // Already on disk from a previous lookup
        if FileManager.default.fileExists(atPath: filePath) { return filePath }

        let keysToFetch: [CNKeyDescriptor] = [
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactImageDataKey as CNKeyDescriptor,
            CNContactImageDataAvailableKey as CNKeyDescriptor
        ]

        // Try phone number match first (most reliable)
        if let phone = phoneNumber, !phone.isEmpty {
            let phonePredicate = CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: phone))
            if let contacts = try? contactStore.unifiedContacts(matching: phonePredicate, keysToFetch: keysToFetch) {
                for contact in contacts {
                    if contact.imageDataAvailable, let imageData = contact.imageData {
                        try? FileManager.default.createDirectory(atPath: avatarsDir, withIntermediateDirectories: true)
                        if FileManager.default.createFile(atPath: filePath, contents: imageData) {
                            return filePath
                        }
                    }
                }
            }
        }

        // Fall back to name-based search
        let parts = name.split(separator: " ", maxSplits: 1)
        let givenName = String(parts.first ?? "")
        let familyName = parts.count > 1 ? String(parts[1]) : ""

        let namePredicate = CNContact.predicateForContacts(matchingName: name)
        if let contacts = try? contactStore.unifiedContacts(matching: namePredicate, keysToFetch: keysToFetch) {
            for contact in contacts {
                let nameMatches = (contact.givenName.lowercased() == givenName.lowercased()) &&
                    (familyName.isEmpty || contact.familyName.lowercased() == familyName.lowercased())
                if nameMatches, contact.imageDataAvailable, let imageData = contact.imageData {
                    try? FileManager.default.createDirectory(atPath: avatarsDir, withIntermediateDirectories: true)
                    if FileManager.default.createFile(atPath: filePath, contents: imageData) {
                        return filePath
                    }
                }
            }
        }

        return nil
    }

    // MARK: - Helpers

    private func channelToDict(_ channel: Channel) -> [String: Any?] {
        return [
            "id": channel.id,
            "name": channel.name,
            "isGroup": channel.isGroup,
            "unreadCount": channel.unreadCount,
            "lastMessage": channel.lastMessage,
            "lastMessageTimestamp": channel.lastMessageTimestamp.map { NSNumber(value: $0) },
            "avatarPath": channel.avatarPath,
            "phoneNumber": channel.phoneNumber
        ]
    }

    private func attachmentToDict(_ attachment: Attachment) -> [String: Any?] {
        var dict: [String: Any?] = [
            "contentType": attachment.contentType,
            "filePath": attachment.filePath,
            "fileName": attachment.fileName,
        ]
        dict["width"] = attachment.width.map { NSNumber(value: $0) }
        dict["height"] = attachment.height.map { NSNumber(value: $0) }
        dict["size"] = attachment.size.map { NSNumber(value: $0) }

        // Generate thumbnail for video attachments
        if attachment.contentType.hasPrefix("video/"), let videoPath = attachment.filePath {
            dict["thumbnailPath"] = generateVideoThumbnail(videoPath: videoPath)
        }

        return dict
    }

    private func generateVideoThumbnail(videoPath: String) -> String? {
        let thumbPath = videoPath + ".thumb.jpg"
        if FileManager.default.fileExists(atPath: thumbPath) {
            return thumbPath
        }

        let url = URL(fileURLWithPath: videoPath)
        let asset = AVAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 560, height: 720)

        let time = CMTime(seconds: 0, preferredTimescale: 600)
        do {
            let cgImage = try generator.copyCGImage(at: time, actualTime: nil)
            let rep = NSBitmapImageRep(cgImage: cgImage)
            guard let jpegData = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else {
                return nil
            }
            try jpegData.write(to: URL(fileURLWithPath: thumbPath))
            return thumbPath
        } catch {
            NSLog("PresageModule: Failed to generate video thumbnail: \(error)")
            return nil
        }
    }

    private func reactionToDict(_ reaction: Reaction) -> [String: Any] {
        return [
            "emoji": reaction.emoji,
            "senderId": reaction.senderId,
            "targetTimestamp": NSNumber(value: reaction.targetTimestamp),
        ]
    }

    private func reactionEventToDict(_ event: ReactionEvent) -> [String: Any] {
        return [
            "channelId": event.channelId,
            "emoji": event.emoji,
            "senderId": event.senderId,
            "targetTimestamp": NSNumber(value: event.targetTimestamp),
            "remove": event.remove,
        ]
    }

    private func messageToDict(_ message: Message) -> [String: Any?] {
        var dict: [String: Any?] = [
            "id": message.id,
            "channelId": message.channelId,
            "senderId": message.senderId,
            "senderName": message.senderName,
            "body": message.body,
            "isOutgoing": message.isOutgoing,
            "status": messageStatusToString(message.status),
        ]
        dict["timestamp"] = NSNumber(value: message.timestamp)
        dict["attachments"] = message.attachments.map { attachmentToDict($0) }
        dict["reactions"] = message.reactions.map { reactionToDict($0) }
        return dict
    }

    private func messageStatusToString(_ status: MessageStatus) -> String {
        switch status {
        case .sending: return "sending"
        case .sent: return "sent"
        case .delivered: return "delivered"
        case .read: return "read"
        case .failed: return "failed"
        }
    }

    // MARK: - Notifications

    private func postNotification(for message: Message) {
        guard !message.isOutgoing, notificationsAuthorized else { return }

        let content = UNMutableNotificationContent()
        avatarCacheLock.lock()
        let channelName = channelNameCache[message.channelId]
        let isGroup = channelIsGroupCache[message.channelId] ?? false
        let avatarPath = channelAvatarCache[message.channelId]
        avatarCacheLock.unlock()

        let displayName = channelName ?? message.senderName ?? "Hush"
        content.title = displayName
        if isGroup, let senderName = message.senderName {
            content.subtitle = senderName
        }
        if let body = message.body, !body.isEmpty {
            content.body = body
        } else if !message.attachments.isEmpty {
            content.body = "Sent an attachment"
        }
        content.sound = .default
        content.userInfo = ["channelId": message.channelId]

        // Build Communication Notification via INSendMessageIntent
        // This replaces the app name in the notification header with the sender/channel name
        let senderHandle = INPersonHandle(value: message.senderId, type: .unknown)
        var senderImage: INImage? = nil
        if let avatarPath = avatarPath, FileManager.default.fileExists(atPath: avatarPath) {
            senderImage = INImage(url: URL(fileURLWithPath: avatarPath))
        }
        let sender = INPerson(
            personHandle: senderHandle,
            nameComponents: nil,
            displayName: message.senderName ?? displayName,
            image: senderImage,
            contactIdentifier: nil,
            customIdentifier: message.senderId
        )

        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: content.body,
            speakableGroupName: isGroup ? INSpeakableString(spokenPhrase: displayName) : nil,
            conversationIdentifier: message.channelId,
            serviceName: nil,
            sender: sender,
            attachments: nil
        )
        #if canImport(UIKit)
        if isGroup, let senderImage = senderImage {
            intent.setImage(senderImage, forParameterNamed: \.speakableGroupName)
        }
        #endif

        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.donate(completion: nil)

        do {
            let updatedContent = try content.updating(from: intent)
            let request = UNNotificationRequest(identifier: "msg-\(message.id)", content: updatedContent, trigger: nil)
            UNUserNotificationCenter.current().add(request) { error in
                if let error = error {
                    NSLog("PresageModule: Failed to post notification: \(error)")
                }
            }
        } catch {
            NSLog("PresageModule: Failed to create communication notification: \(error), falling back")
            let request = UNNotificationRequest(identifier: "msg-\(message.id)", content: content, trigger: nil)
            UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
        }
    }

    func handleNotificationClick(channelId: String) {
        sendEventIfListening("onNotificationClicked", body: ["channelId": channelId])
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
        }
    }
}

// MARK: - Callback Implementations

class LinkingCallbackImpl: LinkingCallback {
    private let onQrCodeHandler: (String) -> Void
    private let onCompleteHandler: () -> Void
    private let onErrorHandler: (String) -> Void

    init(onQrCode: @escaping (String) -> Void, onComplete: @escaping () -> Void, onError: @escaping (String) -> Void) {
        self.onQrCodeHandler = onQrCode
        self.onCompleteHandler = onComplete
        self.onErrorHandler = onError
    }

    func onQrCodeUrl(url: String) {
        DispatchQueue.main.async {
            self.onQrCodeHandler(url)
        }
    }

    func onLinkingComplete() {
        DispatchQueue.main.async {
            self.onCompleteHandler()
        }
    }

    func onLinkingError(error: String) {
        DispatchQueue.main.async {
            self.onErrorHandler(error)
        }
    }
}

class MessageListenerImpl: MessageListener {
    private let onMessageHandler: (Message) -> Void
    private let onReactionHandler: (ReactionEvent) -> Void
    private let onReadReceiptHandler: (String, [UInt64]) -> Void
    private let onChannelUpdatedHandler: (Channel) -> Void
    private let onErrorHandler: (String) -> Void
    private let onAttachmentDownloadedHandler: (String, String, UInt32, Attachment) -> Void

    init(onMessage: @escaping (Message) -> Void, onReaction: @escaping (ReactionEvent) -> Void, onReadReceipt: @escaping (String, [UInt64]) -> Void, onChannelUpdated: @escaping (Channel) -> Void, onError: @escaping (String) -> Void, onAttachmentDownloaded: @escaping (String, String, UInt32, Attachment) -> Void) {
        self.onMessageHandler = onMessage
        self.onReactionHandler = onReaction
        self.onReadReceiptHandler = onReadReceipt
        self.onChannelUpdatedHandler = onChannelUpdated
        self.onErrorHandler = onError
        self.onAttachmentDownloadedHandler = onAttachmentDownloaded
    }

    func onMessage(message: Message) {
        DispatchQueue.main.async {
            self.onMessageHandler(message)
        }
    }

    func onReaction(reaction: ReactionEvent) {
        DispatchQueue.main.async {
            self.onReactionHandler(reaction)
        }
    }

    func onReadReceipt(senderId: String, timestamps: [UInt64]) {
        DispatchQueue.main.async {
            self.onReadReceiptHandler(senderId, timestamps)
        }
    }

    func onChannelUpdated(channel: Channel) {
        DispatchQueue.main.async {
            self.onChannelUpdatedHandler(channel)
        }
    }

    func onError(error: String) {
        DispatchQueue.main.async {
            self.onErrorHandler(error)
        }
    }

    func onAttachmentDownloaded(channelId: String, messageId: String, attachmentIndex: UInt32, attachment: Attachment) {
        DispatchQueue.main.async {
            self.onAttachmentDownloadedHandler(channelId, messageId, attachmentIndex, attachment)
        }
    }
}

// MARK: - Media Preview Panel

class MediaPreviewPanel {
    private var panel: NSPanel?
    private var player: AVPlayer?
    private var playerView: AVPlayerView?
    private var imageView: NSImageView?

    private static let imageTypes: Set<String> = [
        "image/jpeg", "image/png", "image/gif", "image/webp",
        "image/heic", "image/heif", "image/bmp", "image/tiff"
    ]
    private static let videoTypes: Set<String> = [
        "video/mp4", "video/quicktime", "video/x-m4v", "video/mpeg",
        "video/webm", "video/3gpp", "video/mov"
    ]

    func previewFile(path: String) {
        guard FileManager.default.fileExists(atPath: path) else { return }
        let url = URL(fileURLWithPath: path)
        let ext = url.pathExtension.lowercased()

        if isImage(ext: ext) {
            showImage(url: url)
        } else if isVideo(ext: ext) {
            showVideo(url: url)
        } else {
            // Fallback: try as image, then open externally
            if NSImage(contentsOf: url) != nil {
                showImage(url: url)
            } else {
                NSWorkspace.shared.open(url)
            }
        }
    }

    private func isImage(ext: String) -> Bool {
        return ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif"].contains(ext)
    }

    private func isVideo(ext: String) -> Bool {
        return ["mp4", "mov", "m4v", "mpeg", "mpg", "webm", "3gp", "avi", "mkv"].contains(ext)
    }

    // MARK: - Image

    private func showImage(url: URL) {
        guard let image = NSImage(contentsOf: url) else { return }

        let imageSize = image.size
        let screen = NSScreen.main ?? NSScreen.screens.first!
        let maxW = screen.visibleFrame.width * 0.8
        let maxH = screen.visibleFrame.height * 0.8

        var w = imageSize.width
        var h = imageSize.height

        // Scale down if larger than screen bounds
        if w > maxW || h > maxH {
            let scale = min(maxW / w, maxH / h)
            w = floor(w * scale)
            h = floor(h * scale)
        }

        // Minimum size
        w = max(w, 200)
        h = max(h, 150)

        let p = getOrCreatePanel(size: NSSize(width: w, height: h))

        // Clean up previous content
        cleanUpContent()

        let iv = NSImageView(frame: p.contentView!.bounds)
        iv.image = image
        iv.imageScaling = .scaleProportionallyUpOrDown
        iv.autoresizingMask = [.width, .height]
        p.contentView?.addSubview(iv)
        self.imageView = iv

        p.title = url.lastPathComponent
        showPanel(p)
    }

    // MARK: - Video

    private func showVideo(url: URL) {
        let asset = AVAsset(url: url)
        let videoSize = asset.tracks(withMediaType: .video).first?.naturalSize ?? NSSize(width: 640, height: 480)

        let screen = NSScreen.main ?? NSScreen.screens.first!
        let maxW = screen.visibleFrame.width * 0.8
        let maxH = screen.visibleFrame.height * 0.8

        var w = videoSize.width
        var h = videoSize.height

        if w > maxW || h > maxH {
            let scale = min(maxW / w, maxH / h)
            w = floor(w * scale)
            h = floor(h * scale)
        }

        w = max(w, 320)
        h = max(h, 240)

        let p = getOrCreatePanel(size: NSSize(width: w, height: h))

        // Clean up previous content
        cleanUpContent()

        let avPlayer = AVPlayer(url: url)
        let pv = AVPlayerView(frame: p.contentView!.bounds)
        pv.player = avPlayer
        pv.autoresizingMask = [.width, .height]
        p.contentView?.addSubview(pv)
        self.player = avPlayer
        self.playerView = pv

        p.title = url.lastPathComponent
        showPanel(p)

        avPlayer.play()
    }

    // MARK: - Panel Management

    private func getOrCreatePanel(size: NSSize) -> NSPanel {
        if let existing = panel {
            existing.setContentSize(size)
            return existing
        }

        let screen = NSScreen.main ?? NSScreen.screens.first!
        let x = screen.visibleFrame.midX - size.width / 2
        let y = screen.visibleFrame.midY - size.height / 2

        let p = NSPanel(
            contentRect: NSRect(x: x, y: y, width: size.width, height: size.height),
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )
        p.isReleasedWhenClosed = false
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.isMovableByWindowBackground = true
        p.animationBehavior = .utilityWindow
        p.titlebarAppearsTransparent = false
        p.backgroundColor = .black
        p.minSize = NSSize(width: 200, height: 150)

        // Monitor Escape and Space keys
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self, weak p] event in
            guard let self = self, let panel = p, panel.isVisible else { return event }
            if event.keyCode == 53 { // Escape
                self.closePanel()
                return nil
            }
            if event.keyCode == 49, self.player != nil { // Space
                self.togglePlayPause()
                return nil
            }
            return event
        }

        self.panel = p
        return p
    }

    private func showPanel(_ p: NSPanel) {
        p.center()
        p.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func closePanel() {
        cleanUpContent()
        panel?.orderOut(nil)
    }

    private func cleanUpContent() {
        player?.pause()
        player = nil
        playerView?.removeFromSuperview()
        playerView = nil
        imageView?.removeFromSuperview()
        imageView = nil
        panel?.contentView?.subviews.forEach { $0.removeFromSuperview() }
    }

    private func togglePlayPause() {
        guard let player = player else { return }
        if player.rate == 0 {
            player.play()
        } else {
            player.pause()
        }
    }
}

// MARK: - Audio Player Delegate

class AudioPlayerDelegateProxy: NSObject, AVAudioPlayerDelegate {
    static let shared = AudioPlayerDelegateProxy()
    weak var presageModule: PresageModule?

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        presageModule?.audioDidFinishPlaying()
    }
}

// MARK: - Notification Delegate

class NotificationDelegateHandler: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationDelegateHandler()
    weak var presageModule: PresageModule?

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        if let channelId = userInfo["channelId"] as? String {
            DispatchQueue.main.async {
                self.presageModule?.handleNotificationClick(channelId: channelId)
            }
        }
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
