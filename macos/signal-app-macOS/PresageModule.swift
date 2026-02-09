import Foundation
import Contacts
import AVFoundation
import AppKit
import Quartz

@objc(PresageModule)
class PresageModule: RCTEventEmitter {

    private var client: SignalClient?
    private var hasListeners = false

    // Queue for events that arrive before listeners are ready
    private var pendingQrCodeUrl: String?
    private var currentQrCodeUrl: String?  // Always stores the current QR URL for polling
    private let queueLock = NSLock()

    override init() {
        super.init()
    }

    @objc override static func requiresMainQueueSetup() -> Bool {
        return false
    }

    override func supportedEvents() -> [String]! {
        return ["onMessage", "onChannelUpdated", "onLinkingQrCode", "onLinkingComplete", "onError"]
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

    @objc(initialize:resolver:rejecter:)
    func initialize(_ dataDir: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
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
                    // For contacts without a Signal profile picture, try macOS Contacts
                    if channel.avatarPath == nil && !channel.isGroup {
                        if let path = self.findContactPhoto(phoneNumber: channel.phoneNumber, name: channel.name, channelId: channel.id) {
                            dict["avatarPath"] = path
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

    @objc(startReceiving:rejecter:)
    func startReceiving(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        let listener = MessageListenerImpl(
            onMessage: { [weak self] message in
                self?.sendEventIfListening("onMessage", body: self?.messageToDict(message))
            },
            onChannelUpdated: { [weak self] channel in
                self?.sendEventIfListening("onChannelUpdated", body: self?.channelToDict(channel))
            },
            onError: { [weak self] error in
                self?.sendEventIfListening("onError", body: ["message": error])
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

    // MARK: - Quick Look Preview

    private let quickLookCoordinator = QuickLookCoordinator()

    @objc(previewFile:)
    func previewFile(_ filePath: String) {
        DispatchQueue.main.async {
            self.quickLookCoordinator.previewFile(path: filePath)
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

        let avatarsDir = "/tmp/signal-app-data/avatars"
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
    private let onChannelUpdatedHandler: (Channel) -> Void
    private let onErrorHandler: (String) -> Void

    init(onMessage: @escaping (Message) -> Void, onChannelUpdated: @escaping (Channel) -> Void, onError: @escaping (String) -> Void) {
        self.onMessageHandler = onMessage
        self.onChannelUpdatedHandler = onChannelUpdated
        self.onErrorHandler = onError
    }

    func onMessage(message: Message) {
        DispatchQueue.main.async {
            self.onMessageHandler(message)
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
}

// MARK: - Quick Look

class QuickLookCoordinator: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    private var fileURL: NSURL?

    func previewFile(path: String) {
        fileURL = NSURL(fileURLWithPath: path)
        guard let panel = QLPreviewPanel.shared() else { return }
        panel.dataSource = self
        panel.delegate = self

        if panel.isVisible {
            panel.reloadData()
        } else {
            panel.makeKeyAndOrderFront(nil)
        }
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int {
        return fileURL != nil ? 1 : 0
    }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> (any QLPreviewItem)! {
        return fileURL
    }
}
