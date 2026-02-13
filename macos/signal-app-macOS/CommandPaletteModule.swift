import AppKit

@objc(CommandPaletteModule)
class CommandPaletteModule: RCTEventEmitter {

    private var hasListeners = false
    private var panel: CommandPalettePanel?
    private var keyMonitor: Any?

    override init() {
        super.init()
        setupKeyMonitor()
    }

    @objc override static func requiresMainQueueSetup() -> Bool {
        return false
    }

    override func supportedEvents() -> [String]! {
        return ["onChannelSelected", "onShow", "onDismiss", "onNavigateChannel", "onLetterTyped", "onPasteFiles"]
    }

    override func startObserving() {
        hasListeners = true
    }

    override func stopObserving() {
        hasListeners = false
    }

    // MARK: - Key Monitor

    private func setupKeyMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }

            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let char = event.charactersIgnoringModifiers

            // Cmd+K → toggle command palette
            if mods == [.command] && char == "k" {
                DispatchQueue.main.async {
                    self.togglePanel()
                }
                return nil
            }

            // If command palette is visible, handle its shortcuts here
            // (the search field's NSTextView eats Ctrl+N/P/C and Return)
            if self.panel?.isVisible == true {
                if mods == [.control] && char == "n" {
                    self.panel?.selectNext()
                    return nil
                }
                if mods == [.control] && char == "p" {
                    self.panel?.selectPrevious()
                    return nil
                }
                if mods == [.control] && char == "c" {
                    self.panel?.hidePanel()
                    return nil
                }
                if event.keyCode == 53 { // Escape
                    self.panel?.hidePanel()
                    return nil
                }
                if event.keyCode == 36 { // Return/Enter
                    self.panel?.confirmSelection()
                    return nil
                }
                return event
            }

            // Cmd+Shift+[ → previous channel (keyCode 33 = [ key)
            if event.modifierFlags.contains(.command) && event.modifierFlags.contains(.shift) && event.keyCode == 33 {
                self.emitNavigate(direction: "previous")
                return nil
            }

            // Cmd+Shift+] → next channel (keyCode 30 = ] key)
            if event.modifierFlags.contains(.command) && event.modifierFlags.contains(.shift) && event.keyCode == 30 {
                self.emitNavigate(direction: "next")
                return nil
            }

            // Ctrl+J → next channel
            if mods == [.control] && char == "j" {
                self.emitNavigate(direction: "next")
                return nil
            }

            // Ctrl+K → previous channel
            if mods == [.control] && char == "k" {
                self.emitNavigate(direction: "previous")
                return nil
            }

            // Cmd+V → check if pasteboard has files/images, emit onPasteFiles if so
            if mods == [.command] && char == "v" {
                let pasteboard = NSPasteboard.general
                let hasFiles = pasteboard.canReadObject(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])
                let hasImage = (NSImage(pasteboard: pasteboard) != nil) && !hasFiles
                if hasFiles || hasImage {
                    if self.hasListeners {
                        self.sendEvent(withName: "onPasteFiles", body: ["hasFiles": hasFiles, "hasImage": hasImage])
                    }
                    return nil
                }
                // If pasteboard is text-only, let normal paste proceed
                return event
            }

            // Letter key (no Cmd/Ctrl/Option) → focus input and type
            if (mods.isEmpty || mods == [.shift]),
               let chars = event.characters, chars.count == 1,
               let scalar = chars.unicodeScalars.first,
               CharacterSet.letters.contains(scalar) {
                // Don't intercept if a text field is focused
                if let responder = NSApp.keyWindow?.firstResponder,
                   responder is NSTextView {
                    return event
                }
                self.emitLetterTyped(letter: chars)
                return nil
            }

            return event
        }
    }

    private func emitNavigate(direction: String) {
        guard hasListeners else { return }
        sendEvent(withName: "onNavigateChannel", body: ["direction": direction])
    }

    private func emitLetterTyped(letter: String) {
        guard hasListeners else { return }
        sendEvent(withName: "onLetterTyped", body: ["letter": letter])
    }

    private func togglePanel() {
        ensurePanel()
        guard let panel = panel else { return }

        if panel.isVisible {
            panel.hidePanel()
        } else {
            panel.showPanel()
            if hasListeners {
                sendEvent(withName: "onShow", body: nil)
            }
        }
    }

    private func ensurePanel() {
        if panel == nil {
            let p = CommandPalettePanel()
            p.onChannelSelected = { [weak self] channelId in
                guard let self = self, self.hasListeners else { return }
                self.sendEvent(withName: "onChannelSelected", body: ["channelId": channelId])
            }
            p.onDismissed = { [weak self] in
                guard let self = self, self.hasListeners else { return }
                self.sendEvent(withName: "onDismiss", body: nil)
            }
            panel = p
        }
    }

    // MARK: - Exported Methods

    @objc(updateChannels:)
    func updateChannels(_ channelsArray: NSArray) {
        var channels: [CommandPaletteChannelData] = []
        for item in channelsArray {
            guard let dict = item as? [String: Any],
                  let id = dict["id"] as? String,
                  let name = dict["name"] as? String else {
                continue
            }
            let channel = CommandPaletteChannelData(
                id: id,
                name: name,
                lastMessage: dict["lastMessage"] as? String,
                avatarPath: dict["avatarPath"] as? String,
                isGroup: dict["isGroup"] as? Bool ?? false,
                unreadCount: dict["unreadCount"] as? Int ?? 0
            )
            channels.append(channel)
        }

        DispatchQueue.main.async {
            self.ensurePanel()
            self.panel?.updateChannels(channels)
        }
    }

    @objc(show)
    func show() {
        DispatchQueue.main.async {
            self.ensurePanel()
            self.panel?.showPanel()
            if self.hasListeners {
                self.sendEvent(withName: "onShow", body: nil)
            }
        }
    }

    @objc(hide)
    func hide() {
        DispatchQueue.main.async {
            self.panel?.hidePanel()
        }
    }

    deinit {
        if let monitor = keyMonitor {
            NSEvent.removeMonitor(monitor)
        }
    }
}
