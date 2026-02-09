import AppKit

@available(macOS 26.0, *)
@objc(GlassEffectWrapperView) class GlassEffectWrapperView: RCTUIView {
  private let glassView = NSGlassEffectView()

  @objc var cornerRadius: CGFloat = 0 {
    didSet {
      glassView.cornerRadius = cornerRadius
    }
  }

  @objc var glassTintColor: NSColor? {
    didSet {
      if let color = glassTintColor {
        glassView.tintColor = color
      }
    }
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    glassView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(glassView, positioned: .below, relativeTo: nil)
    NSLayoutConstraint.activate([
      glassView.leadingAnchor.constraint(equalTo: leadingAnchor),
      glassView.trailingAnchor.constraint(equalTo: trailingAnchor),
      glassView.topAnchor.constraint(equalTo: topAnchor),
      glassView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }
}
