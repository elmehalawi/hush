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
        return ["onChannelSelected", "onShow", "onDismiss"]
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
            // Cmd+K
            if event.modifierFlags.contains(.command) && event.charactersIgnoringModifiers == "k" {
                DispatchQueue.main.async {
                    self?.togglePanel()
                }
                return nil // consume the event
            }
            return event
        }
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
                isGroup: dict["isGroup"] as? Bool ?? false
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
