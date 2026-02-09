import AppKit

@available(macOS 26.0, *)
@objc(GlassButtonView) class GlassButtonView: RCTUIView {
  private let button: NSButton

  @objc var title: String = "" {
    didSet {
      button.title = title
    }
  }

  @objc var bezelColor: NSColor? {
    didSet {
      if let color = bezelColor {
        button.bezelColor = color
      }
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
    addSubview(button)
    NSLayoutConstraint.activate([
      button.leadingAnchor.constraint(equalTo: leadingAnchor),
      button.trailingAnchor.constraint(equalTo: trailingAnchor),
      button.topAnchor.constraint(equalTo: topAnchor),
      button.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  @objc private func buttonPressed() {
    onPressCallback?([:])
  }
}
