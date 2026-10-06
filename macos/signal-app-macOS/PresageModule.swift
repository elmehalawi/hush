import Foundation
import Contacts
import AVFoundation
import AudioToolbox
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

    // Transcription
    private var transcriptionEngine: TranscriptionEngine?

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
        return ["onMessage", "onReaction", "onReadReceipt", "onReadSync", "onChannelUpdated", "onAttachmentDownloaded", "onLinkPreviewImageDownloaded", "onLinkingQrCode", "onLinkingComplete", "onError", "onNotificationClicked", "onPasteFiles", "onAudioProgress", "onAudioComplete", "onOpenSessions", "onReplyToMessage", "onContextMenuReaction", "onTyping", "onIncomingCall", "onCallStateChanged", "onCallEnded", "onMessagesExpired", "onExpireTimerChanged"]
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
                    if !channel.isGroup {
                        if channel.name.isEmpty {
                            if let contactName = self.findContactName(phoneNumber: channel.phoneNumber) {
                                dict["name"] = contactName
                                self.avatarCacheLock.lock()
                                self.channelNameCache[channel.id] = contactName
                                self.avatarCacheLock.unlock()
                            }
                        }
                        // For contacts without a Signal profile picture, try macOS Contacts
                        if channel.avatarPath == nil {
                            if let path = self.findContactPhoto(phoneNumber: channel.phoneNumber, name: (dict["name"] as? String) ?? channel.name, channelId: channel.id) {
                                dict["avatarPath"] = path
                                self.avatarCacheLock.lock()
                                self.channelAvatarCache[channel.id] = path
                                self.avatarCacheLock.unlock()
                            }
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
            onReadSync: { [weak self] channelId, unreadCount in
                self?.sendEventIfListening("onReadSync", body: [
                    "channelId": channelId,
                    "unreadCount": NSNumber(value: unreadCount)
                ])
            },
            onChannelUpdated: { [weak self] channel in
                guard let self = self else { return }
                var dict = self.channelToDict(channel)
                self.avatarCacheLock.lock()
                if !channel.name.isEmpty {
                    self.channelNameCache[channel.id] = channel.name
                }
                self.channelIsGroupCache[channel.id] = channel.isGroup
                if let avatarPath = channel.avatarPath {
                    self.channelAvatarCache[channel.id] = avatarPath
                }
                self.avatarCacheLock.unlock()
                // For contacts without a name, try macOS system Contacts
                if channel.name.isEmpty && !channel.isGroup {
                    if let contactName = self.findContactName(phoneNumber: channel.phoneNumber) {
                        dict["name"] = contactName
                        self.avatarCacheLock.lock()
                        self.channelNameCache[channel.id] = contactName
                        self.avatarCacheLock.unlock()
                    }
                }
                self.sendEventIfListening("onChannelUpdated", body: dict)
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
            },
            onLinkPreviewImageDownloaded: { [weak self] channelId, messageId, previewIndex, attachment in
                guard let self = self else { return }
                let body: [String: Any] = [
                    "channelId": channelId,
                    "messageId": messageId,
                    "previewIndex": NSNumber(value: previewIndex),
                    "image": self.attachmentToDict(attachment),
                ]
                self.sendEventIfListening("onLinkPreviewImageDownloaded", body: body)
            },
            onTyping: { [weak self] channelId, senderId, started in
                self?.sendEventIfListening("onTyping", body: [
                    "channelId": channelId,
                    "senderId": senderId,
                    "started": started,
                ])
            },
            onMessagesExpired: { [weak self] channelId, messageIds, filePaths in
                // Disappearing messages are gone from the store; take their
                // notifications and image thumbnails with them
                UNUserNotificationCenter.current().removeDeliveredNotifications(
                    withIdentifiers: messageIds.map { "msg-\($0)" })
                for path in filePaths {
                    let stem = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
                    try? FileManager.default.removeItem(atPath: NSTemporaryDirectory() + "thumb_" + stem + ".jpg")
                }
                self?.sendEventIfListening("onMessagesExpired", body: [
                    "channelId": channelId,
                    "messageIds": messageIds,
                ])
            },
            onExpireTimerChanged: { [weak self] channelId, seconds in
                self?.sendEventIfListening("onExpireTimerChanged", body: [
                    "channelId": channelId,
                    "seconds": NSNumber(value: seconds),
                ])
            }
        )

        // Wire up call event listener
        let callListener = CallEventListenerImpl(
            onIncomingCall: { [weak self] call in
                self?.sendEventIfListening("onIncomingCall", body: [
                    "remotePeerId": call.remotePeerId,
                    "callId": NSNumber(value: call.callId),
                    "isVideo": call.isVideo,
                ])

            },
            onCallStateChanged: { [weak self] peerId, state, callId in
                self?.sendEventIfListening("onCallStateChanged", body: [
                    "remotePeerId": peerId,
                    "state": state,
                    "callId": NSNumber(value: callId),
                ])
            },
            onCallEnded: { [weak self] peerId, reason in
                self?.sendEventIfListening("onCallEnded", body: [
                    "remotePeerId": peerId,
                    "reason": reason,
                ])

            }
        )
        client.setCallListener(listener: callListener)

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

    @objc(unlink:rejecter:)
    func unlink(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try client.unlink()
                NSLog("PresageModule: Device unlinked")
                resolver(nil)
            } catch {
                NSLog("PresageModule: Unlink failed: %@", error.localizedDescription)
                rejecter("UNLINK_ERROR", "Failed to unlink: \(error.localizedDescription)", error)
            }
        }
    }

    // MARK: - Call Methods

    @objc(startCall:isVideo:resolver:rejecter:)
    func startCall(_ channelId: String, isVideo: Bool, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }
        do {
            try client.startCall(channelId: channelId, isVideo: isVideo)
            resolver(nil)
        } catch {
            rejecter("CALL_ERROR", "Failed to start call: \(error.localizedDescription)", error)
        }
    }

    @objc(acceptCall:resolver:rejecter:)
    func acceptCall(_ callId: UInt64, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }
        do {
            try client.acceptCall(callId: callId)
            resolver(nil)
        } catch {
            rejecter("CALL_ERROR", "Failed to accept call: \(error.localizedDescription)", error)
        }
    }

    @objc(hangupCall:rejecter:)
    func hangupCall(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }
        do {
            try client.hangupCall()
            resolver(nil)
        } catch {
            rejecter("CALL_ERROR", "Failed to hang up: \(error.localizedDescription)", error)
        }
    }

    @objc(setCallMuted:resolver:rejecter:)
    func setCallMuted(_ muted: Bool, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }
        do {
            try client.setCallMuted(muted: muted)
            resolver(nil)
        } catch {
            rejecter("CALL_ERROR", "Failed to set muted: \(error.localizedDescription)", error)
        }
    }

    // MARK: - Retry Download

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

    // MARK: - Link Preview

    @objc(fetchLinkPreviewMetadata:resolver:rejecter:)
    func fetchLinkPreviewMetadata(_ urlString: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let url = URL(string: urlString), url.scheme == "https" else {
            rejecter("INVALID_URL", "Only HTTPS URLs are supported", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            var request = URLRequest(url: url)
            request.setValue("WhatsApp/2", forHTTPHeaderField: "User-Agent")
            request.timeoutInterval = 10

            let semaphore = DispatchSemaphore(value: 0)
            var responseData: Data?
            var responseError: Error?

            let task = URLSession.shared.dataTask(with: request) { data, response, error in
                responseData = data
                responseError = error
                semaphore.signal()
            }
            task.resume()
            semaphore.wait()

            if let error = responseError {
                rejecter("FETCH_ERROR", "Failed to fetch URL: \(error.localizedDescription)", error)
                return
            }

            guard let data = responseData, let html = String(data: data, encoding: .utf8) else {
                rejecter("PARSE_ERROR", "Failed to decode HTML", nil)
                return
            }

            // Parse OG tags
            let title = self.extractOGTag(html: html, property: "og:title")
            let description = self.extractOGTag(html: html, property: "og:description")
            let imageUrl = self.extractOGTag(html: html, property: "og:image")
            let dateStr = self.extractOGTag(html: html, property: "og:published_time")
                ?? self.extractOGTag(html: html, property: "article:published_time")

            var result: [String: Any?] = [
                "url": urlString,
                "title": title,
                "description": description,
            ]

            // Parse date if present
            if let dateStr = dateStr {
                let formatter = ISO8601DateFormatter()
                if let date = formatter.date(from: dateStr) {
                    result["date"] = NSNumber(value: Int64(date.timeIntervalSince1970 * 1000))
                }
            }

            // Download OG image to temp file
            if let imageUrlStr = imageUrl, let imageUrl = URL(string: imageUrlStr) {
                var imgRequest = URLRequest(url: imageUrl)
                imgRequest.timeoutInterval = 10
                var imgData: Data?
                let imgSemaphore = DispatchSemaphore(value: 0)
                let imgTask = URLSession.shared.dataTask(with: imgRequest) { data, _, _ in
                    imgData = data
                    imgSemaphore.signal()
                }
                imgTask.resume()
                imgSemaphore.wait()

                if let imgData = imgData, !imgData.isEmpty {
                    let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
                    let ext = imageUrl.pathExtension.isEmpty ? "jpg" : imageUrl.pathExtension
                    let fileName = "link_preview_\(UUID().uuidString).\(ext)"
                    let filePath = cacheDir.appendingPathComponent(fileName)
                    do {
                        try imgData.write(to: filePath)
                        result["imagePath"] = filePath.path
                    } catch {
                        NSLog("PresageModule: Failed to save preview image: \(error)")
                    }
                }
            }

            resolver(result)
        }
    }

    private func extractOGTag(html: String, property: String) -> String? {
        // Match: <meta property="og:title" content="...">
        // Also handles name= instead of property=, and single/double quotes
        let patterns = [
            "property=[\"']\(property)[\"']\\s+content=[\"']([^\"']*)[\"']",
            "content=[\"']([^\"']*)[\"']\\s+property=[\"']\(property)[\"']",
            "name=[\"']\(property)[\"']\\s+content=[\"']([^\"']*)[\"']",
            "content=[\"']([^\"']*)[\"']\\s+name=[\"']\(property)[\"']",
        ]
        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) {
                let range = NSRange(html.startIndex..., in: html)
                if let match = regex.firstMatch(in: html, range: range) {
                    if let contentRange = Range(match.range(at: 1), in: html) {
                        let value = String(html[contentRange])
                        if !value.isEmpty {
                            return value
                                .replacingOccurrences(of: "&amp;", with: "&")
                                .replacingOccurrences(of: "&lt;", with: "<")
                                .replacingOccurrences(of: "&gt;", with: ">")
                                .replacingOccurrences(of: "&quot;", with: "\"")
                                .replacingOccurrences(of: "&#39;", with: "'")
                        }
                    }
                }
            }
        }
        return nil
    }

    @objc(sendMessageWithPreviews:text:attachmentPaths:linkPreviews:resolver:rejecter:)
    func sendMessageWithPreviews(_ channelId: String, text: String?, attachmentPaths: [String], linkPreviews: [[String: Any]], resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let previews = linkPreviews.map { dict -> LinkPreviewData in
                    LinkPreviewData(
                        url: dict["url"] as? String ?? "",
                        title: dict["title"] as? String,
                        description: dict["description"] as? String,
                        imagePath: dict["imagePath"] as? String,
                        date: (dict["date"] as? NSNumber)?.uint64Value
                    )
                }
                let message = try client.sendMessageWithPreviews(
                    channelId: channelId,
                    text: text,
                    attachmentPaths: attachmentPaths,
                    linkPreviews: previews
                )
                resolver(self.messageToDict(message))
            } catch {
                rejecter("SEND_ERROR", "Failed to send message with previews: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(sendMessageWithQuote:text:attachmentPaths:linkPreviews:quote:resolver:rejecter:)
    func sendMessageWithQuote(_ channelId: String, text: String?, attachmentPaths: [String], linkPreviews: [[String: Any]], quote: [String: Any], resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        guard let client = client else {
            rejecter("NOT_INITIALIZED", "Client not initialized", nil)
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let previews = linkPreviews.map { dict -> LinkPreviewData in
                    LinkPreviewData(
                        url: dict["url"] as? String ?? "",
                        title: dict["title"] as? String,
                        description: dict["description"] as? String,
                        imagePath: dict["imagePath"] as? String,
                        date: (dict["date"] as? NSNumber)?.uint64Value
                    )
                }
                let quoteObj = Quote(
                    id: (quote["id"] as? NSNumber)?.uint64Value ?? 0,
                    authorId: quote["authorId"] as? String ?? "",
                    authorName: quote["authorName"] as? String,
                    text: quote["text"] as? String
                )
                let message = try client.sendMessageWithQuote(
                    channelId: channelId,
                    text: text,
                    attachmentPaths: attachmentPaths,
                    linkPreviews: previews,
                    quote: quoteObj
                )
                resolver(self.messageToDict(message))
            } catch {
                rejecter("SEND_ERROR", "Failed to send message with quote: \(error.localizedDescription)", error)
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

    /// Downloads the video behind an Instagram/TikTok link and resolves with it
    /// shaped like a received video attachment, so it renders the same way.
    @objc(downloadSocialVideo:resolver:rejecter:)
    func downloadSocialVideo(_ urlString: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        SocialVideoDownloader.shared.download(url: urlString) { result in
            switch result {
            case .failure(let error):
                NSLog("PresageModule: social video download failed for %@: %@", urlString, error.localizedDescription)
                rejecter("SOCIAL_VIDEO_FAILED", error.localizedDescription, error)
            case .success(let path):
                let asset = AVAsset(url: URL(fileURLWithPath: path))
                guard let track = asset.tracks(withMediaType: .video).first else {
                    rejecter("SOCIAL_VIDEO_FAILED", "Downloaded file has no video track", nil)
                    return
                }
                // Portrait phone video is often stored landscape with a rotation.
                let size = track.naturalSize.applying(track.preferredTransform)
                let fileSize = (try? FileManager.default.attributesOfItem(atPath: path)[.size]) as? NSNumber
                resolver([
                    "contentType": "video/mp4",
                    "filePath": path,
                    "fileName": "video.mp4",
                    "width": NSNumber(value: Int(abs(size.width))),
                    "height": NSNumber(value: Int(abs(size.height))),
                    "size": fileSize ?? NSNull(),
                    "thumbnailPath": self.generateVideoThumbnail(videoPath: path) ?? NSNull(),
                ])
            }
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

    // MARK: - Transcription

    /// MLX loads its Metal kernels from `mlx.metallib` next to the executable.
    /// When it can't find one it tears down the whole process rather than
    /// returning an error, so check first and fail as a normal promise
    /// rejection instead of taking the app down with us.
    private func metallibMissingMessage() -> String? {
        guard let exeDir = Bundle.main.executableURL?.deletingLastPathComponent() else {
            return "Cannot locate the app bundle to load transcription kernels."
        }
        let metallib = exeDir.appendingPathComponent("mlx.metallib")
        if FileManager.default.fileExists(atPath: metallib.path) {
            return nil
        }
        return "Transcription is unavailable: mlx.metallib is missing from this build of Hush."
    }

    @objc(prepareTranscriptionModel:rejecter:)
    func prepareTranscriptionModel(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .userInitiated).async {
            if let reason = self.metallibMissingMessage() {
                NSLog("PresageModule: %@", reason)
                rejecter("TRANSCRIBE_MODEL_ERROR", reason, nil)
                return
            }
            do {
                if self.transcriptionEngine == nil {
                    let assetsDir = (Bundle.main.resourcePath ?? "") + "/whisper-assets"
                    let modelRepo = "mlx-community/whisper-large-v3-turbo"
                    self.transcriptionEngine = TranscriptionEngine(assetsDir: assetsDir, modelRepo: modelRepo)
                }
                try self.transcriptionEngine?.prepareModel()
                NSLog("PresageModule: Transcription model loaded successfully")
                resolver(nil)
            } catch {
                NSLog("PresageModule: Failed to prepare transcription model: \(error)")
                rejecter("TRANSCRIBE_MODEL_ERROR", "Failed to prepare transcription model: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(transcribeAudio:resolver:rejecter:)
    func transcribeAudio(_ filePath: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .userInitiated).async {
            // Check cache first
            let cacheFile = filePath + ".transcription.json"
            if let cachedData = FileManager.default.contents(atPath: cacheFile),
               let cached = try? JSONSerialization.jsonObject(with: cachedData) as? [String: Any] {
                NSLog("PresageModule: Returning cached transcription for %@", filePath)
                resolver(cached)
                return
            }

            if let reason = self.metallibMissingMessage() {
                NSLog("PresageModule: %@", reason)
                rejecter("TRANSCRIBE_MODEL_ERROR", reason, nil)
                return
            }

            // Ensure engine is ready
            if self.transcriptionEngine == nil || !(self.transcriptionEngine?.isModelLoaded() ?? false) {
                do {
                    if self.transcriptionEngine == nil {
                        let assetsDir = (Bundle.main.resourcePath ?? "") + "/whisper-assets"
                        let modelRepo = "mlx-community/whisper-large-v3-turbo"
                        self.transcriptionEngine = TranscriptionEngine(assetsDir: assetsDir, modelRepo: modelRepo)
                    }
                    try self.transcriptionEngine?.prepareModel()
                } catch {
                    NSLog("PresageModule: Transcription model error: %@", "\(error)")
                    rejecter("TRANSCRIBE_MODEL_ERROR", "Failed to load model: \(error.localizedDescription)", error)
                    return
                }
            }

            // Convert audio to WAV if needed
            let wavPath: String
            do {
                wavPath = try self.convertToWav(filePath: filePath)
            } catch {
                NSLog("PresageModule: Audio convert error: %@", "\(error)")
                rejecter("TRANSCRIBE_AUDIO_ERROR", "Failed to convert audio: \(error.localizedDescription)", error)
                return
            }

            // Run transcription
            do {
                let result = try self.transcriptionEngine!.transcribeFile(audioPath: wavPath, language: nil)

                let segments: [[String: Any]] = result.segments.map { seg in
                    return [
                        "start": seg.start,
                        "end": seg.end,
                        "text": seg.text,
                    ]
                }

                let dict: [String: Any] = [
                    "text": result.text,
                    "language": result.language,
                    "segments": segments,
                ]

                // Cache the result
                if let jsonData = try? JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted]) {
                    FileManager.default.createFile(atPath: cacheFile, contents: jsonData)
                }

                // Clean up temp WAV if we created one
                if wavPath != filePath {
                    try? FileManager.default.removeItem(atPath: wavPath)
                }

                resolver(dict)
            } catch {
                // Clean up temp WAV if we created one
                if wavPath != filePath {
                    try? FileManager.default.removeItem(atPath: wavPath)
                }
                NSLog("PresageModule: Transcription error: %@", "\(error)")
                rejecter("TRANSCRIBE_ERROR", "Transcription failed: \(error.localizedDescription)", error)
            }
        }
    }

    @objc(getCachedTranscription:resolver:rejecter:)
    func getCachedTranscription(_ filePath: String, resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        DispatchQueue.global(qos: .utility).async {
            let cacheFile = filePath + ".transcription.json"
            if let cachedData = FileManager.default.contents(atPath: cacheFile),
               let cached = try? JSONSerialization.jsonObject(with: cachedData) as? [String: Any] {
                resolver(cached)
            } else {
                resolver(nil)
            }
        }
    }

    @objc(isTranscriptionModelReady:rejecter:)
    func isTranscriptionModelReady(_ resolver: @escaping RCTPromiseResolveBlock, rejecter: @escaping RCTPromiseRejectBlock) {
        resolver(transcriptionEngine?.isModelLoaded() ?? false)
    }

    /// 16kHz mono Float32 — the format the transcriber expects.
    private static let transcriptionFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: true)!

    /// Convert an audio file to 16kHz mono WAV for transcription.
    ///
    /// Takes two decoders, because neither covers everything Signal delivers.
    /// AVAssetReader reads the usual containers (M4A, AAC ADTS, MP3) but flatly
    /// refuses AMR, which is what forwarded voicemails arrive as. ExtAudioFile
    /// decodes AMR, but picks its parser from the file extension and so chokes on
    /// attachments whose extension disagrees with their container — Signal hands
    /// us M4A audio under a .aac name, and anything it has no mapping for lands
    /// as .bin. Trying one then the other covers every case we see.
    private func convertToWav(filePath: String) throws -> String {
        let url = URL(fileURLWithPath: filePath)
        let ext = url.pathExtension.lowercased()

        // If already a WAV, return as-is
        if ext == "wav" {
            return filePath
        }

        let tmpDir = NSTemporaryDirectory()
        let wavName = (filePath as NSString).lastPathComponent.replacingOccurrences(of: ".\(ext)", with: ".wav")
        let wavPath = "\(tmpDir)\(wavName)_\(Int(Date().timeIntervalSince1970 * 1000)).wav"

        do {
            try convertUsingAssetReader(url: url, wavPath: wavPath)
            return wavPath
        } catch {
            NSLog("PresageModule: AVAssetReader could not decode %@ (%@), retrying with ExtAudioFile",
                  filePath, "\(error)")
            try? FileManager.default.removeItem(atPath: wavPath)
        }

        try convertUsingExtAudioFile(url: url, wavPath: wavPath)
        return wavPath
    }

    private func convertUsingAssetReader(url: URL, wavPath: String) throws {
        let asset = AVAsset(url: url)
        let reader = try AVAssetReader(asset: asset)

        guard let audioTrack = asset.tracks(withMediaType: .audio).first else {
            throw NSError(domain: "PresageModule", code: -1, userInfo: [NSLocalizedDescriptionKey: "No audio track in file"])
        }

        // Request 16kHz mono Float32 PCM output
        let outputSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]

        let trackOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: outputSettings)
        reader.add(trackOutput)
        reader.startReading()

        // Write WAV output
        let wavFormat = Self.transcriptionFormat
        let outputFile = try AVAudioFile(forWriting: URL(fileURLWithPath: wavPath), settings: wavFormat.settings)
        var framesWritten: AVAudioFramePosition = 0

        while let sampleBuffer = trackOutput.copyNextSampleBuffer() {
            guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { continue }
            var length = 0
            var dataPointer: UnsafeMutablePointer<Int8>?
            guard CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil,
                                              totalLengthOut: &length, dataPointerOut: &dataPointer) == noErr,
                  let dataPointer = dataPointer,
                  length >= MemoryLayout<Float>.size else { continue }

            // Copy whole frames only — a partial trailing frame would send the
            // memcpy past the end of the buffer we just sized.
            let frameCount = AVAudioFrameCount(length / MemoryLayout<Float>.size)
            guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: wavFormat, frameCapacity: frameCount) else { continue }
            pcmBuffer.frameLength = frameCount
            memcpy(pcmBuffer.floatChannelData![0], dataPointer, Int(frameCount) * MemoryLayout<Float>.size)
            try outputFile.write(from: pcmBuffer)
            framesWritten += AVAudioFramePosition(frameCount)
        }

        if reader.status == .failed {
            throw reader.error ?? NSError(domain: "PresageModule", code: -3, userInfo: [NSLocalizedDescriptionKey: "AVAssetReader failed"])
        }

        // A reader that opens the file but yields nothing leaves us with a WAV
        // the transcriber can only choke on. Treat it as a failure so the
        // ExtAudioFile path gets a turn.
        guard framesWritten > 0 else {
            throw NSError(domain: "PresageModule", code: -5, userInfo: [NSLocalizedDescriptionKey: "No audio samples decoded"])
        }
    }

    /// Decode via AudioToolbox, which opens formats AVFoundation won't touch
    /// (notably AMR) and resamples to the client format on the way out.
    private func convertUsingExtAudioFile(url: URL, wavPath: String) throws {
        var handle: ExtAudioFileRef?
        var status = ExtAudioFileOpenURL(url as CFURL, &handle)
        guard status == noErr, let audioFile = handle else {
            throw NSError(domain: "PresageModule", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "Unsupported audio format"])
        }
        defer { ExtAudioFileDispose(audioFile) }

        let wavFormat = Self.transcriptionFormat
        var clientFormat = wavFormat.streamDescription.pointee
        status = ExtAudioFileSetProperty(audioFile, kExtAudioFileProperty_ClientDataFormat,
                                         UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &clientFormat)
        guard status == noErr else {
            throw NSError(domain: "PresageModule", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "Cannot resample audio to 16kHz mono"])
        }

        let outputFile = try AVAudioFile(forWriting: URL(fileURLWithPath: wavPath), settings: wavFormat.settings)
        let capacity: AVAudioFrameCount = 4096
        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: wavFormat, frameCapacity: capacity) else {
            throw NSError(domain: "PresageModule", code: -4,
                          userInfo: [NSLocalizedDescriptionKey: "Cannot allocate audio buffer"])
        }

        while true {
            var frames = capacity
            var bufferList = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
                mNumberChannels: 1,
                mDataByteSize: capacity * UInt32(MemoryLayout<Float>.size),
                mData: pcmBuffer.floatChannelData![0]))
            status = ExtAudioFileRead(audioFile, &frames, &bufferList)
            guard status == noErr else {
                throw NSError(domain: "PresageModule", code: Int(status),
                              userInfo: [NSLocalizedDescriptionKey: "Failed to read audio data"])
            }
            if frames == 0 { break }
            pcmBuffer.frameLength = frames
            try outputFile.write(from: pcmBuffer)
        }
    }

    // MARK: - Channel Context Menu

    @objc(showChannelContextMenu:isGroup:expireTimer:)
    func showChannelContextMenu(_ channelId: String, isGroup: Bool, expireTimer: Double) {
        DispatchQueue.main.async {
            let menu = NSMenu()

            let timerItem = NSMenuItem(title: "Disappearing Messages", action: nil, keyEquivalent: "")
            timerItem.submenu = self.expireTimerMenu(channelId: channelId, isGroup: isGroup, current: UInt32(expireTimer))
            menu.addItem(timerItem)

            if !isGroup {
                menu.addItem(NSMenuItem.separator())
                let resetItem = NSMenuItem(title: "Reset Session", action: #selector(self.handleResetSession(_:)), keyEquivalent: "")
                resetItem.representedObject = channelId
                resetItem.target = self
                menu.addItem(resetItem)
            }

            self.popUpAtMouse(menu)
        }
    }

    // MARK: - Disappearing Messages

    /// The timers the official clients offer, in seconds (0 = off)
    private static let expireTimerChoices: [UInt32] = [0, 30, 5 * 60, 60 * 60, 8 * 60 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60, 4 * 7 * 24 * 60 * 60]

    @objc(showExpireTimerMenu:isGroup:expireTimer:)
    func showExpireTimerMenu(_ channelId: String, isGroup: Bool, expireTimer: Double) {
        DispatchQueue.main.async {
            self.popUpAtMouse(self.expireTimerMenu(channelId: channelId, isGroup: isGroup, current: UInt32(expireTimer)))
        }
    }

    private func popUpAtMouse(_ menu: NSMenu) {
        guard let window = NSApp.keyWindow, let contentView = window.contentView else { return }
        let mouseInWindow = window.mouseLocationOutsideOfEventStream
        let mouseInView = contentView.convert(mouseInWindow, from: nil)
        menu.popUp(positioning: nil, at: mouseInView, in: contentView)
    }

    private func expireTimerMenu(channelId: String, isGroup: Bool, current: UInt32) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        var choices = Self.expireTimerChoices
        // Someone may have picked a custom timer on their phone
        if !choices.contains(current) {
            choices.append(current)
            choices.sort()
        }
        for seconds in choices {
            let item = NSMenuItem(title: Self.expireTimerLabel(seconds), action: #selector(handleSetExpireTimer(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = ["channelId": channelId, "seconds": NSNumber(value: seconds)]
            item.state = seconds == current ? .on : .off
            // A group's timer lives in the group's server-side state, which
            // Hush can't change yet
            item.isEnabled = !isGroup
            menu.addItem(item)
        }
        if isGroup {
            menu.addItem(NSMenuItem.separator())
            let note = NSMenuItem(title: "Change a group's timer from your phone", action: nil, keyEquivalent: "")
            note.isEnabled = false
            menu.addItem(note)
        }
        return menu
    }

    private static func expireTimerLabel(_ seconds: UInt32) -> String {
        if seconds == 0 { return "Off" }
        let units: [(UInt32, String)] = [(7 * 24 * 60 * 60, "week"), (24 * 60 * 60, "day"), (60 * 60, "hour"), (60, "minute"), (1, "second")]
        for (size, name) in units where seconds % size == 0 {
            let count = seconds / size
            return "\(count) \(name)\(count == 1 ? "" : "s")"
        }
        return "\(seconds) seconds"
    }

    @objc private func handleSetExpireTimer(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: Any],
              let channelId = info["channelId"] as? String,
              let seconds = (info["seconds"] as? NSNumber)?.uint32Value,
              let client = client else { return }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let notice = try client.setExpireTimer(channelId: channelId, seconds: seconds)
                self.sendEventIfListening("onMessage", body: self.messageToDict(notice))
            } catch {
                NSLog("PresageModule: Failed to set disappearing timer: %@", error.localizedDescription)
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Couldn't Change Disappearing Messages"
                    alert.informativeText = error.localizedDescription
                    alert.alertStyle = .warning
                    alert.addButton(withTitle: "OK")
                    alert.runModal()
                }
            }
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

    @objc(showMessageContextMenu:messageTimestamp:messageSenderId:messageSenderName:channelId:existingReactionEmoji:attachmentFilePath:attachmentFileName:)
    func showMessageContextMenu(_ messageBody: String, messageTimestamp: Double, messageSenderId: String, messageSenderName: String, channelId: String, existingReactionEmoji: String, attachmentFilePath: String, attachmentFileName: String) {
        DispatchQueue.main.async {
            let menu = NSMenu()

            // Emoji reaction row at top of menu
            let activeEmoji = existingReactionEmoji.isEmpty ? nil : existingReactionEmoji
            let emojiItem = NSMenuItem()
            emojiItem.view = EmojiReactionRowView(activeEmoji: activeEmoji) { [weak self] emoji, isRemove in
                self?.sendEventIfListening("onContextMenuReaction", body: [
                    "channelId": channelId,
                    "emoji": emoji,
                    "targetTimestamp": NSNumber(value: messageTimestamp),
                    "remove": isRemove,
                ])
            }
            menu.addItem(emojiItem)
            menu.addItem(NSMenuItem.separator())

            if !messageBody.isEmpty {
                let copyItem = NSMenuItem(title: "Copy", action: #selector(self.handleCopyMessageText(_:)), keyEquivalent: "")
                copyItem.representedObject = messageBody
                copyItem.target = self
                menu.addItem(copyItem)
            }

            let replyItem = NSMenuItem(title: "Reply", action: #selector(self.handleReplyToMessage(_:)), keyEquivalent: "")
            replyItem.representedObject = [
                "id": messageTimestamp,
                "authorId": messageSenderId,
                "authorName": messageSenderName,
                "text": messageBody,
            ] as [String: Any]
            replyItem.target = self
            menu.addItem(replyItem)

            // Append file actions when an attachment is present
            if !attachmentFilePath.isEmpty {
                menu.addItem(NSMenuItem.separator())

                let saveItem = NSMenuItem(title: "Save to Downloads", action: #selector(self.handleSaveToDownloads(_:)), keyEquivalent: "")
                saveItem.representedObject = ["path": attachmentFilePath, "name": attachmentFileName]
                saveItem.target = self
                menu.addItem(saveItem)

                let openItem = NSMenuItem(title: "Open", action: #selector(self.handleOpenFile(_:)), keyEquivalent: "")
                openItem.representedObject = attachmentFilePath
                openItem.target = self
                menu.addItem(openItem)
            }

            guard let window = NSApp.keyWindow, let contentView = window.contentView else { return }
            if let currentEvent = NSApp.currentEvent {
                NSMenu.popUpContextMenu(menu, with: currentEvent, for: contentView)
            } else {
                let mouseInWindow = window.mouseLocationOutsideOfEventStream
                let mouseInView = contentView.convert(mouseInWindow, from: nil)
                menu.popUp(positioning: nil, at: mouseInView, in: contentView)
            }
        }
    }

    @objc private func handleCopyMessageText(_ sender: NSMenuItem) {
        guard let text = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    @objc private func handleReplyToMessage(_ sender: NSMenuItem) {
        guard let data = sender.representedObject as? [String: Any] else { return }
        sendEventIfListening("onReplyToMessage", body: data)
    }

    // MARK: - File Context Menu

    @objc(showFileContextMenu:fileName:)
    func showFileContextMenu(_ filePath: String, fileName: String) {
        DispatchQueue.main.async {
            let menu = NSMenu()

            let saveItem = NSMenuItem(title: "Save to Downloads", action: #selector(self.handleSaveToDownloads(_:)), keyEquivalent: "")
            saveItem.representedObject = ["path": filePath, "name": fileName]
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

    /// Pick the name a saved attachment should get in ~/Downloads.
    ///
    /// The sender controls `originalName`, so strip any directory components
    /// before it is joined onto the Downloads path.
    static func downloadFileName(originalName: String, cachedPath: String) -> String {
        let trimmed = originalName.trimmingCharacters(in: .whitespacesAndNewlines)
        let sanitized = (trimmed as NSString).lastPathComponent
        if !sanitized.isEmpty, sanitized != ".", sanitized != ".." {
            return sanitized
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        let stamp = formatter.string(from: Date())
        let ext = (cachedPath as NSString).pathExtension
        return ext.isEmpty
            ? "Hush Attachment \(stamp)"
            : "Hush Attachment \(stamp).\(ext)"
    }

    @objc private func handleSaveToDownloads(_ sender: NSMenuItem) {
        guard let info = sender.representedObject as? [String: String],
              let filePath = info["path"], !filePath.isEmpty else { return }
        let fileManager = FileManager.default
        guard let downloadsURL = fileManager.urls(for: .downloadsDirectory, in: .userDomainMask).first else { return }
        // Prefer the original sender-provided filename (it carries the correct
        // extension). The cached disk name is a content digest, so falling back
        // to it would produce names like "a3f9e2...bin"; synthesize a readable
        // name instead when the sender supplied none.
        let fileName = Self.downloadFileName(
            originalName: info["name"] ?? "",
            cachedPath: filePath
        )
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

    @objc(previewFiles:index:)
    func previewFiles(_ filePaths: [String], index: Double) {
        DispatchQueue.main.async {
            self.mediaPreviewPanel.previewFiles(paths: filePaths, index: Int(index))
        }
    }

    // MARK: - macOS Contacts Integration

    private lazy var contactStore = CNContactStore()
    private var contactsAccessGranted: Bool?

    /// Cache of phone-number-digits → display name from macOS Contacts.
    /// Built once per app launch to avoid repeated CNContactStore enumeration.
    private var contactNameByDigits: [String: String]?

    private func buildContactNameCache() {
        guard contactNameByDigits == nil else { return }

        // Check / request access on first call
        if contactsAccessGranted == nil {
            let semaphore = DispatchSemaphore(value: 0)
            contactStore.requestAccess(for: .contacts) { granted, _ in
                self.contactsAccessGranted = granted
                semaphore.signal()
            }
            semaphore.wait()
        }
        guard contactsAccessGranted == true else {
            contactNameByDigits = [:]
            return
        }

        var cache: [String: String] = [:]
        let keysToFetch: [CNKeyDescriptor] = [
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
        ]
        let request = CNContactFetchRequest(keysToFetch: keysToFetch)
        do {
            try contactStore.enumerateContacts(with: request) { contact, _ in
                let given = contact.givenName
                let family = contact.familyName
                guard !given.isEmpty || !family.isEmpty else { return }
                let displayName = family.isEmpty ? given : "\(given) \(family)"
                for labeledValue in contact.phoneNumbers {
                    let digits = labeledValue.value.stringValue.filter { $0.isNumber }
                    let key = String(digits.suffix(10))
                    if !key.isEmpty {
                        cache[key] = displayName
                    }
                }
            }
        } catch {
            NSLog("PresageModule: buildContactNameCache failed: %@", "\(error)")
        }
        contactNameByDigits = cache
    }

    /// Look up a contact name from macOS Contacts by phone number.
    private func findContactName(phoneNumber: String?) -> String? {
        guard let phone = phoneNumber, !phone.isEmpty else { return nil }
        buildContactNameCache()
        let digits = phone.filter { $0.isNumber }
        let key = String(digits.suffix(10))
        return contactNameByDigits?[key]
    }

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
            let digits = phone.filter { $0.isNumber }
            let variants = Set([phone, digits, String(digits.suffix(10))])
            for variant in variants {
                guard !variant.isEmpty else { continue }
                let phonePredicate = CNContact.predicateForContacts(matching: CNPhoneNumber(stringValue: variant))
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
            "phoneNumber": channel.phoneNumber,
            "expireTimer": NSNumber(value: channel.expireTimer)
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

    private func mentionToDict(_ mention: Mention) -> [String: Any?] {
        return [
            "start": NSNumber(value: mention.start),
            "length": NSNumber(value: mention.length),
            "uuid": mention.uuid,
            "name": mention.name,
        ]
    }

    private func linkPreviewToDict(_ preview: LinkPreview) -> [String: Any?] {
        return [
            "url": preview.url,
            "title": preview.title,
            "description": preview.description,
            "date": preview.date.map { NSNumber(value: $0) },
            "image": preview.image.map { attachmentToDict($0) },
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
        dict["mentions"] = message.mentions.map { mentionToDict($0) }
        dict["readBy"] = message.readBy
        dict["linkPreviews"] = message.previews.map { linkPreviewToDict($0) }
        if let quote = message.quote {
            dict["quote"] = quoteToDict(quote)
        }
        dict["messageType"] = messageTypeToString(message.messageType)
        dict["edited"] = message.edited
        dict["expireTimer"] = NSNumber(value: message.expireTimer)
        return dict
    }

    private func quoteToDict(_ quote: Quote) -> [String: Any?] {
        return [
            "id": NSNumber(value: quote.id),
            "authorId": quote.authorId,
            "authorName": quote.authorName,
            "text": quote.text,
        ]
    }

    private func messageTypeToString(_ messageType: MessageType) -> String {
        switch messageType {
        case .regular: return "regular"
        case .missedAudioCall: return "missedAudioCall"
        case .missedVideoCall: return "missedVideoCall"
        case .audioCall: return "audioCall"
        case .videoCall: return "videoCall"
        case .timerUpdate: return "timerUpdate"
        }
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
        guard !message.isOutgoing, message.messageType != .timerUpdate, notificationsAuthorized else { return }

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

class CallEventListenerImpl: CallEventListener {
    private let onIncomingCallHandler: (CallInfo) -> Void
    private let onCallStateChangedHandler: (String, String, UInt64) -> Void
    private let onCallEndedHandler: (String, String) -> Void

    init(onIncomingCall: @escaping (CallInfo) -> Void, onCallStateChanged: @escaping (String, String, UInt64) -> Void, onCallEnded: @escaping (String, String) -> Void) {
        self.onIncomingCallHandler = onIncomingCall
        self.onCallStateChangedHandler = onCallStateChanged
        self.onCallEndedHandler = onCallEnded
    }

    func onIncomingCall(call: CallInfo) {
        DispatchQueue.main.async {
            self.onIncomingCallHandler(call)
        }
    }

    func onCallStateChanged(remotePeerId: String, state: String, callId: UInt64) {
        DispatchQueue.main.async {
            self.onCallStateChangedHandler(remotePeerId, state, callId)
        }
    }

    func onCallEnded(remotePeerId: String, reason: String) {
        DispatchQueue.main.async {
            self.onCallEndedHandler(remotePeerId, reason)
        }
    }
}

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
    private let onReadSyncHandler: (String, UInt32) -> Void
    private let onChannelUpdatedHandler: (Channel) -> Void
    private let onErrorHandler: (String) -> Void
    private let onAttachmentDownloadedHandler: (String, String, UInt32, Attachment) -> Void
    private let onLinkPreviewImageDownloadedHandler: (String, String, UInt32, Attachment) -> Void
    private let onTypingHandler: (String, String, Bool) -> Void
    private let onMessagesExpiredHandler: (String, [String], [String]) -> Void
    private let onExpireTimerChangedHandler: (String, UInt32) -> Void

    init(onMessage: @escaping (Message) -> Void, onReaction: @escaping (ReactionEvent) -> Void, onReadReceipt: @escaping (String, [UInt64]) -> Void, onReadSync: @escaping (String, UInt32) -> Void, onChannelUpdated: @escaping (Channel) -> Void, onError: @escaping (String) -> Void, onAttachmentDownloaded: @escaping (String, String, UInt32, Attachment) -> Void, onLinkPreviewImageDownloaded: @escaping (String, String, UInt32, Attachment) -> Void, onTyping: @escaping (String, String, Bool) -> Void, onMessagesExpired: @escaping (String, [String], [String]) -> Void, onExpireTimerChanged: @escaping (String, UInt32) -> Void) {
        self.onMessageHandler = onMessage
        self.onReactionHandler = onReaction
        self.onReadReceiptHandler = onReadReceipt
        self.onReadSyncHandler = onReadSync
        self.onChannelUpdatedHandler = onChannelUpdated
        self.onErrorHandler = onError
        self.onAttachmentDownloadedHandler = onAttachmentDownloaded
        self.onLinkPreviewImageDownloadedHandler = onLinkPreviewImageDownloaded
        self.onTypingHandler = onTyping
        self.onMessagesExpiredHandler = onMessagesExpired
        self.onExpireTimerChangedHandler = onExpireTimerChanged
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

    func onReadSync(channelId: String, unreadCount: UInt32) {
        DispatchQueue.main.async {
            self.onReadSyncHandler(channelId, unreadCount)
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

    func onLinkPreviewImageDownloaded(channelId: String, messageId: String, previewIndex: UInt32, attachment: Attachment) {
        DispatchQueue.main.async {
            self.onLinkPreviewImageDownloadedHandler(channelId, messageId, previewIndex, attachment)
        }
    }

    func onTyping(channelId: String, senderId: String, started: Bool) {
        DispatchQueue.main.async {
            self.onTypingHandler(channelId, senderId, started)
        }
    }

    func onMessagesExpired(channelId: String, messageIds: [String], filePaths: [String]) {
        DispatchQueue.main.async {
            self.onMessagesExpiredHandler(channelId, messageIds, filePaths)
        }
    }

    func onExpireTimerChanged(channelId: String, seconds: UInt32) {
        DispatchQueue.main.async {
            self.onExpireTimerChangedHandler(channelId, seconds)
        }
    }
}

// MARK: - Media Preview Panel

class MediaPreviewPanel: NSObject, NSWindowDelegate {
    /// Identifies the preview window so other app-wide key monitors
    /// (e.g. CommandPaletteModule) can leave its key events alone.
    static let windowIdentifier = NSUserInterfaceItemIdentifier("HushMediaPreview")

    private var panel: NSPanel?
    private let mediaContainer = NSView()
    private var filmstrip: MediaFilmstripView?
    private var player: AVPlayer?
    private var playerView: AVPlayerView?
    private var imageView: NSImageView?
    private var keyMonitor: Any?
    private var scrollMonitor: Any?

    private var items: [URL] = []
    private var currentIndex = 0

    /// Horizontal travel accumulated during the current trackpad gesture.
    private var swipeDeltaX: CGFloat = 0
    private var swipeDeltaY: CGFloat = 0
    /// Set once a gesture has stepped, so one swipe moves exactly one item
    /// and its momentum events are swallowed.
    private var swipeHandled = false

    override init() {
        super.init()
        setupKeyMonitor()
        setupSwipeMonitor()
    }

    func previewFile(path: String) {
        previewFiles(paths: [path], index: 0)
    }

    func previewFiles(paths: [String], index: Int) {
        let urls = paths
            .filter { FileManager.default.fileExists(atPath: $0) }
            .map { URL(fileURLWithPath: $0) }
        guard !urls.isEmpty else { return }

        // Map the requested index onto the filtered list.
        var start = 0
        if index >= 0 && index < paths.count {
            let requested = URL(fileURLWithPath: paths[index])
            start = urls.firstIndex(of: requested) ?? 0
        }

        // Not an image/video → hand off to the default app.
        guard canPreview(url: urls[start]) else {
            NSWorkspace.shared.open(urls[start])
            return
        }

        items = urls.filter { canPreview(url: $0) }
        currentIndex = items.firstIndex(of: urls[start]) ?? 0
        showCurrent(recenter: true)
    }

    private func canPreview(url: URL) -> Bool {
        let ext = url.pathExtension.lowercased()
        return isImage(ext: ext) || isVideo(ext: ext) || NSImage(contentsOf: url) != nil
    }

    private func isImage(ext: String) -> Bool {
        return ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif"].contains(ext)
    }

    private func isVideo(ext: String) -> Bool {
        return ["mp4", "mov", "m4v", "mpeg", "mpg", "webm", "3gp", "avi", "mkv"].contains(ext)
    }

    // MARK: - Navigation

    private func showCurrent(recenter: Bool) {
        guard currentIndex >= 0 && currentIndex < items.count else { return }
        let url = items[currentIndex]
        if isVideo(ext: url.pathExtension.lowercased()) {
            showVideo(url: url, recenter: recenter)
        } else {
            showImage(url: url, recenter: recenter)
        }
    }

    private func step(_ delta: Int) {
        guard items.count > 1 else { return }
        currentIndex = (currentIndex + delta + items.count) % items.count
        showCurrent(recenter: false)
    }

    private func jump(to index: Int) {
        guard index != currentIndex, index >= 0, index < items.count else { return }
        currentIndex = index
        showCurrent(recenter: false)
    }

    private func titleFor(url: URL) -> String {
        if items.count > 1 {
            return "\(url.lastPathComponent)  (\(currentIndex + 1)/\(items.count))"
        }
        return url.lastPathComponent
    }

    private var showsFilmstrip: Bool { items.count > 1 }

    private var filmstripHeight: CGFloat { showsFilmstrip ? MediaFilmstripView.height : 0 }

    /// Window content size for media of `size`: the media scaled to fit the
    /// screen, plus the filmstrip bar underneath it.
    private func contentSize(forMedia size: NSSize, minSize: NSSize) -> NSSize {
        let screen = panel?.screen ?? NSScreen.main ?? NSScreen.screens.first!
        let maxW = screen.visibleFrame.width * 0.8
        let maxH = screen.visibleFrame.height * 0.8 - filmstripHeight

        var w = size.width
        var h = size.height

        // Scale down if larger than screen bounds
        if w > maxW || h > maxH {
            let scale = min(maxW / w, maxH / h)
            w = floor(w * scale)
            h = floor(h * scale)
        }

        let minW = showsFilmstrip ? max(minSize.width, 360) : minSize.width
        return NSSize(width: max(w, minW), height: max(h, minSize.height) + filmstripHeight)
    }

    // MARK: - Image

    private func showImage(url: URL, recenter: Bool) {
        guard let image = NSImage(contentsOf: url) else { return }

        let size = contentSize(forMedia: image.size, minSize: NSSize(width: 200, height: 150))
        let p = getOrCreatePanel(size: size, recenter: recenter)

        // Clean up previous content
        cleanUpContent()

        let iv = NSImageView(frame: mediaContainer.bounds)
        iv.image = image
        iv.imageScaling = .scaleProportionallyUpOrDown
        iv.autoresizingMask = [.width, .height]
        mediaContainer.addSubview(iv)
        self.imageView = iv

        p.title = titleFor(url: url)
        showPanel(p, recenter: recenter)
    }

    // MARK: - Video

    private func showVideo(url: URL, recenter: Bool) {
        let asset = AVAsset(url: url)
        let videoSize = asset.tracks(withMediaType: .video).first?.naturalSize ?? NSSize(width: 640, height: 480)

        let size = contentSize(forMedia: videoSize, minSize: NSSize(width: 320, height: 240))
        let p = getOrCreatePanel(size: size, recenter: recenter)

        // Clean up previous content
        cleanUpContent()

        let avPlayer = AVPlayer(url: url)
        let pv = AVPlayerView(frame: mediaContainer.bounds)
        pv.player = avPlayer
        pv.autoresizingMask = [.width, .height]
        mediaContainer.addSubview(pv)
        self.player = avPlayer
        self.playerView = pv

        p.title = titleFor(url: url)
        showPanel(p, recenter: recenter)

        avPlayer.play()
    }

    // MARK: - Panel Management

    private func getOrCreatePanel(size: NSSize, recenter: Bool) -> NSPanel {
        let p = panel ?? makePanel(size: size)

        if !recenter && p.isVisible {
            // Resize around the current center so cycling doesn't make
            // the window jump back to the middle of the screen.
            let old = p.frame
            p.setContentSize(size)
            var frame = p.frame
            frame.origin.x = old.midX - frame.width / 2
            frame.origin.y = old.midY - frame.height / 2
            p.setFrame(frame, display: true)
        } else {
            p.setContentSize(size)
        }

        updateFilmstrip(in: p)
        return p
    }

    private func makePanel(size: NSSize) -> NSPanel {
        let screen = NSScreen.main ?? NSScreen.screens.first!
        let x = screen.visibleFrame.midX - size.width / 2
        let y = screen.visibleFrame.midY - size.height / 2

        let p = NSPanel(
            contentRect: NSRect(x: x, y: y, width: size.width, height: size.height),
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )
        p.identifier = MediaPreviewPanel.windowIdentifier
        p.isReleasedWhenClosed = false
        p.isFloatingPanel = true
        p.hidesOnDeactivate = false
        p.isMovableByWindowBackground = true
        p.animationBehavior = .utilityWindow
        p.titlebarAppearsTransparent = false
        p.backgroundColor = .black
        p.minSize = NSSize(width: 200, height: 150)

        mediaContainer.frame = p.contentView!.bounds
        mediaContainer.autoresizingMask = [.width, .height]
        p.contentView?.addSubview(mediaContainer)

        p.delegate = self
        self.panel = p
        return p
    }

    /// Shows the filmstrip below the media when there's more than one item,
    /// rebuilding its thumbnails when the set of items changes.
    private func updateFilmstrip(in p: NSPanel) {
        guard let contentView = p.contentView else { return }
        let bounds = contentView.bounds

        if showsFilmstrip {
            let strip: MediaFilmstripView
            if let existing = filmstrip {
                strip = existing
            } else {
                strip = MediaFilmstripView(frame: NSRect(x: 0, y: 0, width: bounds.width, height: MediaFilmstripView.height))
                strip.onSelect = { [weak self] index in self?.jump(to: index) }
                strip.autoresizingMask = [.width, .maxYMargin]
                contentView.addSubview(strip)
                filmstrip = strip
            }
            strip.frame = NSRect(x: 0, y: 0, width: bounds.width, height: MediaFilmstripView.height)
            if strip.items != items {
                strip.setItems(items, isVideo: { [weak self] in self?.isVideo(ext: $0.pathExtension.lowercased()) ?? false })
            }
            strip.select(currentIndex)
        } else {
            filmstrip?.removeFromSuperview()
            filmstrip = nil
        }

        mediaContainer.frame = NSRect(
            x: 0, y: filmstripHeight,
            width: bounds.width, height: bounds.height - filmstripHeight
        )
        p.minSize = NSSize(width: 200, height: 150 + filmstripHeight)
    }

    /// Only handles keys while the preview window itself is key, so the main
    /// window keeps its shortcuts when the preview is open in the background.
    private func setupKeyMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, let panel = self.panel, panel.isVisible,
                  event.window === panel else { return event }

            let mods = event.modifierFlags.intersection([.command, .control, .option])
            guard mods.isEmpty else { return event }

            switch event.keyCode {
            case 53: // Escape
                self.closePanel()
                return nil
            case 49: // Space
                if self.player != nil { self.togglePlayPause() }
                return nil
            case 123: // Left arrow
                self.step(-1)
                return nil
            case 124: // Right arrow
                self.step(1)
                return nil
            default:
                break
            }

            switch event.charactersIgnoringModifiers?.lowercased() {
            case "h":
                self.step(-1)
                return nil
            case "l":
                self.step(1)
                return nil
            case "o":
                self.closePanel()
                self.focusMainWindow()
                return nil
            default:
                return event
            }
        }
    }

    /// Two-finger horizontal swipe on the trackpad steps through the items,
    /// one item per gesture. Fingers right → previous, like Photos/Safari.
    private func setupSwipeMonitor() {
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self = self, let panel = self.panel, panel.isVisible,
                  event.window === panel else { return event }
            return self.handleSwipe(event)
        }
    }

    /// Returns nil when the event was consumed as part of a swipe.
    private func handleSwipe(_ event: NSEvent) -> NSEvent? {
        guard items.count > 1, event.hasPreciseScrollingDeltas else { return event }

        // Let the filmstrip scroll itself when its thumbnails overflow
        if let strip = filmstrip, strip.isScrollable,
           strip.frame.contains(strip.superview!.convert(event.locationInWindow, from: nil)) {
            return event
        }

        // Inertia after the fingers lift
        if !event.momentumPhase.isEmpty {
            return swipeHandled ? nil : event
        }

        if event.phase.contains(.began) {
            swipeDeltaX = 0
            swipeDeltaY = 0
            swipeHandled = false
        }

        swipeDeltaX += event.scrollingDeltaX
        swipeDeltaY += event.scrollingDeltaY

        let horizontal = abs(swipeDeltaX) > abs(swipeDeltaY) * 1.5
        if !swipeHandled && horizontal && abs(swipeDeltaX) > 50 {
            swipeHandled = true
            // Normalize so positive means the fingers physically moved right
            let rightward = event.isDirectionInvertedFromDevice ? swipeDeltaX : -swipeDeltaX
            step(rightward > 0 ? -1 : 1)
        }

        return horizontal || swipeHandled ? nil : event
    }

    func windowWillClose(_ notification: Notification) {
        cleanUpContent()
    }

    private func showPanel(_ p: NSPanel, recenter: Bool) {
        if recenter { p.center() }
        p.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func closePanel() {
        cleanUpContent()
        panel?.orderOut(nil)
    }

    private func focusMainWindow() {
        let main = NSApp.windows.first(where: { $0.isVisible && !($0 is NSPanel) })
        main?.makeKeyAndOrderFront(nil)
    }

    private func cleanUpContent() {
        player?.pause()
        player = nil
        playerView = nil
        imageView = nil
        mediaContainer.subviews.forEach { $0.removeFromSuperview() }
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

// MARK: - Media Filmstrip

/// Bottom bar of the media preview: a row of thumbnails with the current
/// item highlighted. Sits below the media rather than over it.
class MediaFilmstripView: NSVisualEffectView {
    static let height: CGFloat = 64
    private static let thumbSize: CGFloat = 44
    private static let spacing: CGFloat = 6
    private static let inset: CGFloat = 12

    var onSelect: ((Int) -> Void)?
    private(set) var items: [URL] = []

    private let scrollView = NSScrollView()
    private let documentView = NSView()
    private var thumbs: [FilmstripThumbView] = []
    private var selectedIndex = 0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        material = .hudWindow
        blendingMode = .behindWindow
        state = .followsWindowActiveState

        let separator = NSBox()
        separator.boxType = .separator
        separator.frame = NSRect(x: 0, y: Self.height - 1, width: frameRect.width, height: 1)
        separator.autoresizingMask = [.width, .minYMargin]
        addSubview(separator)

        scrollView.frame = bounds
        scrollView.autoresizingMask = [.width, .height]
        scrollView.drawsBackground = false
        scrollView.hasHorizontalScroller = false
        scrollView.hasVerticalScroller = false
        scrollView.horizontalScrollElasticity = .allowed
        scrollView.verticalScrollElasticity = .none
        scrollView.documentView = documentView
        addSubview(scrollView, positioned: .below, relativeTo: separator)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// True when the thumbnails are wider than the bar.
    var isScrollable: Bool {
        documentView.frame.width > scrollView.contentView.bounds.width + 0.5
    }

    func setItems(_ urls: [URL], isVideo: (URL) -> Bool) {
        items = urls
        thumbs.forEach { $0.removeFromSuperview() }
        thumbs = urls.enumerated().map { index, url in
            let thumb = FilmstripThumbView(url: url, isVideo: isVideo(url))
            thumb.onClick = { [weak self] in self?.onSelect?(index) }
            documentView.addSubview(thumb)
            return thumb
        }
        needsLayout = true
    }

    func select(_ index: Int) {
        selectedIndex = index
        for (i, thumb) in thumbs.enumerated() {
            thumb.isSelected = i == index
        }
        layoutSubtreeIfNeeded()
        scrollSelectedIntoView()
    }

    override func layout() {
        super.layout()
        let n = CGFloat(thumbs.count)
        let total = n * Self.thumbSize + max(n - 1, 0) * Self.spacing
        let visibleWidth = scrollView.contentView.bounds.width
        let docWidth = max(total + Self.inset * 2, visibleWidth)
        documentView.frame = NSRect(x: 0, y: 0, width: docWidth, height: bounds.height)

        // Centered when they fit, otherwise laid out from the leading edge
        var x = floor((docWidth - total) / 2)
        let y = floor((bounds.height - Self.thumbSize) / 2)
        for thumb in thumbs {
            thumb.frame = NSRect(x: x, y: y, width: Self.thumbSize, height: Self.thumbSize)
            x += Self.thumbSize + Self.spacing
        }
    }

    private func scrollSelectedIntoView() {
        guard selectedIndex >= 0, selectedIndex < thumbs.count, isScrollable else { return }
        // Keep the current item centered so its neighbours stay visible
        let visibleWidth = scrollView.contentView.bounds.width
        let maxX = documentView.frame.width - visibleWidth
        let x = min(max(thumbs[selectedIndex].frame.midX - visibleWidth / 2, 0), maxX)
        scrollView.contentView.scroll(to: NSPoint(x: x, y: 0))
        scrollView.reflectScrolledClipView(scrollView.contentView)
    }
}

private class FilmstripThumbView: NSView {
    var onClick: (() -> Void)?

    var isSelected = false {
        didSet { updateAppearance() }
    }

    private let imageLayer = CALayer()
    private var playBadge: NSImageView?

    init(url: URL, isVideo: Bool) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 5
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor.white.withAlphaComponent(0.08).cgColor

        imageLayer.contentsGravity = .resizeAspectFill
        imageLayer.masksToBounds = true
        layer?.addSublayer(imageLayer)

        if isVideo {
            let badge = NSImageView()
            badge.image = NSImage(systemSymbolName: "play.fill", accessibilityDescription: "Video")
            badge.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 12, weight: .semibold)
            badge.contentTintColor = .white
            badge.shadow = {
                let s = NSShadow()
                s.shadowBlurRadius = 3
                s.shadowColor = NSColor.black.withAlphaComponent(0.6)
                return s
            }()
            addSubview(badge)
            playBadge = badge
        }

        updateAppearance()
        loadThumbnail(url: url, isVideo: isVideo)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.frame = bounds
        CATransaction.commit()
        playBadge?.frame = bounds
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateAppearance()
    }

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private func updateAppearance() {
        layer?.borderWidth = isSelected ? 2 : 0
        layer?.borderColor = NSColor.controlAccentColor.cgColor
        alphaValue = isSelected ? 1 : 0.55
    }

    private func loadThumbnail(url: URL, isVideo: Bool) {
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let maxPixels = 44 * scale * 1.5
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var image: CGImage?
            if isVideo {
                let generator = AVAssetImageGenerator(asset: AVAsset(url: url))
                generator.appliesPreferredTrackTransform = true
                generator.maximumSize = CGSize(width: maxPixels, height: maxPixels)
                image = try? generator.copyCGImage(at: .zero, actualTime: nil)
            } else if let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
                let options: [CFString: Any] = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: maxPixels,
                ]
                image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
            }
            DispatchQueue.main.async {
                self?.imageLayer.contents = image
            }
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

// MARK: - Emoji Reaction Row View (for context menu)

private class EmojiReactionRowView: NSView {
    static let row1 = ["❤️", "👍", "👎", "😂", "😮", "😢"]
    static let row2 = ["🔥", "🎉", "🤞", "😍", "💯", "🙏"]
    private var allEmojis: [String] { Self.row1 + Self.row2 }
    private let columns = 6

    private let buttonSize: CGFloat = 34
    private let spacing: CGFloat = 2
    private let hPadding: CGFloat = 8
    private let vPadding: CGFloat = 6
    private let rowSpacing: CGFloat = 2

    private var hoveredIndex: Int = -1
    private var activeEmoji: String?
    private var onSelect: ((String, Bool) -> Void)?
    private var emojiTrackingAreas: [NSTrackingArea] = []

    convenience init(activeEmoji: String?, onSelect: @escaping (String, Bool) -> Void) {
        let count = CGFloat(6)
        let totalWidth = count * 34 + (count - 1) * 2 + 2 * 8
        let totalHeight = 2 * 34.0 + 2.0 + 2 * 6.0
        self.init(frame: NSRect(x: 0, y: 0, width: totalWidth, height: totalHeight))
        self.activeEmoji = activeEmoji
        self.onSelect = onSelect
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
    }

    override var intrinsicContentSize: NSSize {
        return frame.size
    }

    private func buttonRect(at index: Int) -> NSRect {
        let col = index % columns
        let row = index / columns
        let x = hPadding + CGFloat(col) * (buttonSize + spacing)
        // Row 0 is top (row1), row 1 is bottom (row2). NSView y=0 is bottom.
        let y = vPadding + CGFloat(1 - row) * (buttonSize + rowSpacing)
        return NSRect(x: x, y: y, width: buttonSize, height: buttonSize)
    }

    // MARK: - Tracking Areas (per-emoji, with enabledDuringMouseDrag)

    override func updateTrackingAreas() {
        for area in emojiTrackingAreas {
            removeTrackingArea(area)
        }
        emojiTrackingAreas.removeAll()

        for i in 0..<allEmojis.count {
            let area = NSTrackingArea(
                rect: buttonRect(at: i),
                options: [
                    .enabledDuringMouseDrag,
                    .mouseEnteredAndExited,
                    .activeInActiveApp,
                ],
                owner: self,
                userInfo: ["index": i]
            )
            addTrackingArea(area)
            emojiTrackingAreas.append(area)
        }
    }

    // MARK: - Mouse Events (no mouseDown override — menu owns it)

    override func mouseEntered(with event: NSEvent) {
        guard let index = event.trackingArea?.userInfo?["index"] as? Int else { return }
        hoveredIndex = index
        needsDisplay = true
    }

    override func mouseExited(with event: NSEvent) {
        hoveredIndex = -1
        needsDisplay = true
    }

    private func handleMouseUp() {
        let emojis = allEmojis
        if hoveredIndex >= 0 && hoveredIndex < emojis.count {
            let emoji = emojis[hoveredIndex]
            let isRemove = emoji == activeEmoji
            onSelect?(emoji, isRemove)
        }
        enclosingMenuItem?.menu?.cancelTracking()
    }

    override func mouseUp(with event: NSEvent) {
        handleMouseUp()
    }

    override func rightMouseUp(with event: NSEvent) {
        handleMouseUp()
    }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let emojis = allEmojis
        for (i, emoji) in emojis.enumerated() {
            let rect = buttonRect(at: i)

            let isActive = emoji == activeEmoji
            let isHovered = i == hoveredIndex

            if isActive {
                NSColor.controlAccentColor.withAlphaComponent(0.2).setFill()
                NSBezierPath(roundedRect: rect, xRadius: rect.width / 2, yRadius: rect.height / 2).fill()
            } else if isHovered {
                let isDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                let hoverColor = isDark ? NSColor.white.withAlphaComponent(0.1) : NSColor.black.withAlphaComponent(0.08)
                hoverColor.setFill()
                NSBezierPath(roundedRect: rect, xRadius: rect.width / 2, yRadius: rect.height / 2).fill()
            }

            let attributes: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 20)
            ]
            let attrStr = NSAttributedString(string: emoji, attributes: attributes)
            let strSize = attrStr.size()
            let strRect = NSRect(
                x: rect.midX - strSize.width / 2,
                y: rect.midY - strSize.height / 2,
                width: strSize.width,
                height: strSize.height
            )
            attrStr.draw(in: strRect)
        }
    }
}
