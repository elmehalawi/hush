import AppKit

@available(macOS 26.0, *)
@objc(GlassButtonView) class GlassButtonView: RCTUIView {
  private let button: NSButton

  @objc var title: String = "" {
    didSet {
      button.title = title
    }
  }

  @objc var symbolName: String = "" {
    didSet {
      if !symbolName.isEmpty,
         let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil) {
        let config = NSImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
        button.image = image.withSymbolConfiguration(config)
        button.imagePosition = title.isEmpty ? .imageOnly : .imageLeading
      } else {
        button.image = nil
      }
    }
  }

  @objc var bezelColor: NSColor? {
    didSet {
      if let color = bezelColor {
        button.bezelColor = color
      }
    }
  }

  @objc var enabled: Bool = true {
    didSet {
      button.isEnabled = enabled
    }
  }

  @objc var onPressCallback: RCTBubblingEventBlock?

  override init(frame: NSRect) {
    button = NSButton(frame: .zero)
    super.init(frame: frame)
    button.bezelStyle = .glass
    button.translatesAutoresizingMaskIntoConstraints = false
    button.target = self
    button.action = #selector(buttonPressed)
    wantsLayer = true
    layer?.masksToBounds = true
    addSubview(button)
    NSLayoutConstraint.activate([
      button.leadingAnchor.constraint(equalTo: leadingAnchor),
      button.trailingAnchor.constraint(equalTo: trailingAnchor),
      button.topAnchor.constraint(equalTo: topAnchor),
      button.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  override func layout() {
    super.layout()
    layer?.cornerRadius = min(bounds.width, bounds.height) / 2
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  @objc private func buttonPressed() {
    onPressCallback?([:])
  }
}
