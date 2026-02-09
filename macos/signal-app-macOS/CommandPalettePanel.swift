import AppKit

struct CommandPaletteChannelData {
    let id: String
    let name: String
    let lastMessage: String?
    let avatarPath: String?
    let isGroup: Bool
}

// MARK: - Channel Row View

class ChannelRowView: NSView {
    let channelId: String
    private let avatarView: NSView
    private let avatarLabel: NSTextField
    private var avatarImageLayer: CALayer?
    private let nameLabel: NSTextField
    private let previewLabel: NSTextField
    var isSelected: Bool = false {
        didSet { needsDisplay = true }
    }

    init(channel: CommandPaletteChannelData) {
        self.channelId = channel.id

        // Avatar circle
        avatarView = NSView(frame: NSRect(x: 12, y: 7, width: 32, height: 32))
        avatarView.wantsLayer = true
        avatarView.layer?.cornerRadius = 16

        avatarLabel = NSTextField(labelWithString: "")
        avatarLabel.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        avatarLabel.textColor = .white
        avatarLabel.alignment = .center
        avatarLabel.frame = NSRect(x: 0, y: 0, width: 32, height: 32)

        nameLabel = NSTextField(labelWithString: channel.name)
        nameLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        nameLabel.textColor = .labelColor
        nameLabel.lineBreakMode = .byTruncatingTail

        previewLabel = NSTextField(labelWithString: channel.lastMessage ?? "")
        previewLabel.font = NSFont.systemFont(ofSize: 11)
        previewLabel.textColor = .secondaryLabelColor
        previewLabel.lineBreakMode = .byTruncatingTail

        super.init(frame: NSRect(x: 0, y: 0, width: 480, height: 46))

        wantsLayer = true

        addSubview(avatarView)
        avatarView.addSubview(avatarLabel)

        // Load avatar image or show initial
        if let path = channel.avatarPath, FileManager.default.fileExists(atPath: path),
           let image = NSImage(contentsOfFile: path) {
            avatarView.layer?.backgroundColor = NSColor.clear.cgColor
            avatarLabel.isHidden = true
            let imgLayer = CALayer()
            imgLayer.frame = CGRect(x: 0, y: 0, width: 32, height: 32)
            imgLayer.cornerRadius = 16
            imgLayer.masksToBounds = true
            imgLayer.contents = image
            imgLayer.contentsGravity = .resizeAspectFill
            avatarView.layer?.addSublayer(imgLayer)
            avatarImageLayer = imgLayer
        } else {
            let colors: [NSColor] = [
                NSColor(red: 0.35, green: 0.55, blue: 0.85, alpha: 1),
                NSColor(red: 0.80, green: 0.45, blue: 0.45, alpha: 1),
                NSColor(red: 0.45, green: 0.72, blue: 0.55, alpha: 1),
                NSColor(red: 0.70, green: 0.55, blue: 0.80, alpha: 1),
                NSColor(red: 0.85, green: 0.65, blue: 0.35, alpha: 1),
            ]
            let colorIndex = abs(channel.id.hashValue) % colors.count
            avatarView.layer?.backgroundColor = colors[colorIndex].cgColor
            let initial = String(channel.name.prefix(1)).uppercased()
            avatarLabel.stringValue = initial
        }

        addSubview(nameLabel)
        addSubview(previewLabel)

        nameLabel.translatesAutoresizingMaskIntoConstraints = false
        previewLabel.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            nameLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 52),
            nameLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            nameLabel.topAnchor.constraint(equalTo: topAnchor, constant: 6),

            previewLabel.leadingAnchor.constraint(equalTo: nameLabel.leadingAnchor),
            previewLabel.trailingAnchor.constraint(equalTo: nameLabel.trailingAnchor),
            previewLabel.topAnchor.constraint(equalTo: nameLabel.bottomAnchor, constant: 1),
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ dirtyRect: NSRect) {
        if isSelected {
            NSColor.controlAccentColor.withAlphaComponent(0.2).setFill()
            let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 4, dy: 1), xRadius: 6, yRadius: 6)
            path.fill()
        }
        super.draw(dirtyRect)
    }
}

// MARK: - Command Palette Panel

class CommandPalettePanel: NSPanel, NSSearchFieldDelegate {
    private let blurView: NSVisualEffectView
    private let searchField: NSSearchField
    private let scrollView: NSScrollView
    private let stackView: NSStackView
    private var allChannels: [CommandPaletteChannelData] = []
    private var filteredChannels: [CommandPaletteChannelData] = []
    private var selectedIndex: Int = 0
    private var channelRows: [ChannelRowView] = []

    var onChannelSelected: ((String) -> Void)?
    var onDismissed: (() -> Void)?

    init() {
        blurView = NSVisualEffectView()
        searchField = NSSearchField()
        scrollView = NSScrollView()
        stackView = NSStackView()

        let contentRect = NSRect(x: 0, y: 0, width: 500, height: 400)
        super.init(
            contentRect: contentRect,
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        level = .floating
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        isOpaque = false
        backgroundColor = .clear
        isMovableByWindowBackground = false
        hidesOnDeactivate = false

        // Hide standard window buttons
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true

        setupBlurView()
        setupSearchField()
        setupScrollView()
    }

    private func setupBlurView() {
        blurView.material = .headerView
        blurView.blendingMode = .behindWindow
        blurView.state = .active
        blurView.wantsLayer = true
        blurView.layer?.cornerRadius = 12
        blurView.layer?.masksToBounds = true

        // Subtle border
        blurView.layer?.borderWidth = 0.5
        blurView.layer?.borderColor = NSColor.white.withAlphaComponent(0.15).cgColor

        // Shadow on the panel itself
        hasShadow = true

        contentView = blurView
    }

    private func setupSearchField() {
        searchField.delegate = self
        searchField.placeholderString = "Search channels..."
        searchField.focusRingType = .none
        searchField.font = NSFont.systemFont(ofSize: 15)
        searchField.translatesAutoresizingMaskIntoConstraints = false
        searchField.bezelStyle = .roundedBezel

        blurView.addSubview(searchField)

        NSLayoutConstraint.activate([
            searchField.topAnchor.constraint(equalTo: blurView.topAnchor, constant: 12),
            searchField.leadingAnchor.constraint(equalTo: blurView.leadingAnchor, constant: 12),
            searchField.trailingAnchor.constraint(equalTo: blurView.trailingAnchor, constant: -12),
            searchField.heightAnchor.constraint(equalToConstant: 28),
        ])
    }

    private func setupScrollView() {
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay

        stackView.orientation = .vertical
        stackView.spacing = 0
        stackView.alignment = .leading
        stackView.translatesAutoresizingMaskIntoConstraints = false

        let clipView = NSClipView()
        clipView.drawsBackground = false
        clipView.documentView = stackView
        scrollView.contentView = clipView

        blurView.addSubview(scrollView)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: searchField.bottomAnchor, constant: 8),
            scrollView.leadingAnchor.constraint(equalTo: blurView.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: blurView.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: blurView.bottomAnchor, constant: -8),

            stackView.leadingAnchor.constraint(equalTo: scrollView.leadingAnchor),
            stackView.trailingAnchor.constraint(equalTo: scrollView.trailingAnchor),
            stackView.topAnchor.constraint(equalTo: clipView.topAnchor),
            stackView.widthAnchor.constraint(equalTo: scrollView.widthAnchor),
        ])
    }

    // MARK: - Public API

    func updateChannels(_ channels: [CommandPaletteChannelData]) {
        allChannels = channels
        if isVisible {
            filterAndReload()
        }
    }

    func showPanel() {
        guard let mainWindow = NSApp.mainWindow ?? NSApp.windows.first(where: { $0.isVisible && !($0 is NSPanel) }) else {
            return
        }

        searchField.stringValue = ""
        selectedIndex = 0
        filteredChannels = allChannels
        reloadList()

        // Position centered in upper third of main window
        let mainFrame = mainWindow.frame
        let panelWidth: CGFloat = 500
        let panelHeight = calculateHeight()
        let x = mainFrame.origin.x + (mainFrame.width - panelWidth) / 2
        let y = mainFrame.origin.y + mainFrame.height * 0.65 - panelHeight / 2

        setFrame(NSRect(x: x, y: y, width: panelWidth, height: panelHeight), display: true)

        // Animate in
        alphaValue = 0
        makeKeyAndOrderFront(nil)

        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.15
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.animator().alphaValue = 1
        }

        searchField.becomeFirstResponder()
    }

    func hidePanel() {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.12
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            self.animator().alphaValue = 0
        }, completionHandler: {
            self.orderOut(nil)
            self.onDismissed?()
        })
    }

    // MARK: - Filtering

    private func filterAndReload() {
        let query = searchField.stringValue.lowercased()
        if query.isEmpty {
            filteredChannels = allChannels
        } else {
            filteredChannels = allChannels.filter { $0.name.lowercased().contains(query) }
        }
        selectedIndex = filteredChannels.isEmpty ? -1 : 0
        reloadList()
        resizePanel()
    }

    private func reloadList() {
        channelRows.forEach { $0.removeFromSuperview() }
        channelRows.removeAll()

        for (index, channel) in filteredChannels.enumerated() {
            let row = ChannelRowView(channel: channel)
            row.translatesAutoresizingMaskIntoConstraints = false
            row.isSelected = (index == selectedIndex)

            // Click handler
            let click = NSClickGestureRecognizer(target: self, action: #selector(rowClicked(_:)))
            row.addGestureRecognizer(click)

            stackView.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stackView.widthAnchor).isActive = true
            row.heightAnchor.constraint(equalToConstant: 46).isActive = true

            channelRows.append(row)
        }
    }

    @objc private func rowClicked(_ gesture: NSClickGestureRecognizer) {
        guard let row = gesture.view as? ChannelRowView else { return }
        onChannelSelected?(row.channelId)
        hidePanel()
    }

    private func calculateHeight() -> CGFloat {
        let rowHeight: CGFloat = 46
        let headerHeight: CGFloat = 48 // search field + padding
        let footerPadding: CGFloat = 8
        let contentHeight = headerHeight + CGFloat(filteredChannels.count) * rowHeight + footerPadding
        return min(contentHeight, 400)
    }

    private func resizePanel() {
        let newHeight = calculateHeight()
        var frame = self.frame
        let diff = newHeight - frame.height
        frame.origin.y -= diff
        frame.size.height = newHeight
        setFrame(frame, display: true, animate: true)
    }

    private func updateSelection() {
        for (index, row) in channelRows.enumerated() {
            row.isSelected = (index == selectedIndex)
        }
        // Scroll to selected
        if selectedIndex >= 0 && selectedIndex < channelRows.count {
            channelRows[selectedIndex].scrollToVisible(channelRows[selectedIndex].bounds)
        }
    }

    // MARK: - NSSearchFieldDelegate

    func controlTextDidChange(_ obj: Notification) {
        filterAndReload()
    }

    // MARK: - Key handling

    override func keyDown(with event: NSEvent) {
        let hasControl = event.modifierFlags.contains(.control)
        let char = event.charactersIgnoringModifiers

        switch Int(event.keyCode) {
        case 125: // Down arrow
            selectNext()
        case 126: // Up arrow
            selectPrevious()
        case 36: // Enter/Return
            confirmSelection()
        case 53: // Escape
            hidePanel()
        default:
            if hasControl && char == "n" {
                selectNext()
            } else if hasControl && char == "p" {
                selectPrevious()
            } else if hasControl && char == "c" {
                hidePanel()
            } else {
                super.keyDown(with: event)
            }
        }
    }

    func confirmSelection() {
        if selectedIndex >= 0 && selectedIndex < filteredChannels.count {
            onChannelSelected?(filteredChannels[selectedIndex].id)
            hidePanel()
        }
    }

    func selectNext() {
        if !filteredChannels.isEmpty {
            selectedIndex = min(selectedIndex + 1, filteredChannels.count - 1)
            updateSelection()
        }
    }

    func selectPrevious() {
        if !filteredChannels.isEmpty {
            selectedIndex = max(selectedIndex - 1, 0)
            updateSelection()
        }
    }

    // MARK: - Auto-dismiss

    override func resignKey() {
        super.resignKey()
        if isVisible {
            hidePanel()
        }
    }
}
