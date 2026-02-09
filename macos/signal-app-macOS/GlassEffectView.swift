import AppKit

@available(macOS 26.0, *)
@objc(GlassEffectWrapperView) class GlassEffectWrapperView: RCTUIView {
  private let glassView = NSGlassEffectView()
  private let contentClipView = NSView()

  @objc var cornerRadius: CGFloat = 0 {
    didSet {
      glassView.cornerRadius = cornerRadius
      contentClipView.layer?.cornerRadius = cornerRadius
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
    focusRingType = .none
    wantsLayer = true

    // Glass view behind everything
    glassView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(glassView, positioned: .below, relativeTo: nil)
    NSLayoutConstraint.activate([
      glassView.leadingAnchor.constraint(equalTo: leadingAnchor),
      glassView.trailingAnchor.constraint(equalTo: trailingAnchor),
      glassView.topAnchor.constraint(equalTo: topAnchor),
      glassView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])

    // Content clipping container — clips React children to rounded rect
    contentClipView.wantsLayer = true
    contentClipView.layer?.masksToBounds = true
    contentClipView.layer?.cornerCurve = .continuous
    contentClipView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(contentClipView)
    NSLayoutConstraint.activate([
      contentClipView.leadingAnchor.constraint(equalTo: leadingAnchor),
      contentClipView.trailingAnchor.constraint(equalTo: trailingAnchor),
      contentClipView.topAnchor.constraint(equalTo: topAnchor),
      contentClipView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])

    // Native macOS shadow — soft, high-radius
    let shadow = NSShadow()
    shadow.shadowBlurRadius = 30
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.15)
    shadow.shadowOffset = NSSize(width: 0, height: -2)
    self.shadow = shadow
  }

  override func insertReactSubview(_ subview: NSView!, at atIndex: Int) {
    contentClipView.addSubview(subview)
  }

  override func removeReactSubview(_ subview: NSView!) {
    subview.removeFromSuperview()
  }

  override func reactSubviews() -> [NSView]! {
    return contentClipView.subviews
  }

  override func layout() {
    super.layout()
    layer?.masksToBounds = false
    disableFocusRings(self)
  }

  private func disableFocusRings(_ view: NSView) {
    view.focusRingType = .none
    for subview in view.subviews {
      disableFocusRings(subview)
    }
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }
}
