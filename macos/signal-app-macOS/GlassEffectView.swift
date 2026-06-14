import AppKit

@available(macOS 26.0, *)
@objc(GlassEffectWrapperView) class GlassEffectWrapperView: RCTUIView {
  private let glassView = NSGlassEffectView()
  private var shadowLayer: CALayer?

  @objc var cornerRadius: CGFloat = 0 {
    didSet {
      glassView.cornerRadius = cornerRadius
      updateShadowLayer()
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
    glassView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(glassView, positioned: .below, relativeTo: nil)
    NSLayoutConstraint.activate([
      glassView.leadingAnchor.constraint(equalTo: leadingAnchor),
      glassView.trailingAnchor.constraint(equalTo: trailingAnchor),
      glassView.topAnchor.constraint(equalTo: topAnchor),
      glassView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  override func insertReactSubview(_ subview: NSView!, at atIndex: Int) {
    super.insertReactSubview(subview, at: atIndex)  // React tracking bookkeeping
    addSubview(subview)  // Add to native view hierarchy above the glass background
  }

  override func didUpdateReactSubviews() {
    // No-op: we handle native hierarchy in insertReactSubview.
    // Calling super would re-add tracked subviews, interfering with visibility
    // due to Fabric's deferred commit scheduling.
  }

  override func removeReactSubview(_ subview: NSView!) {
    super.removeReactSubview(subview)
  }

  override func viewDidMoveToSuperview() {
    super.viewDidMoveToSuperview()
    if superview != nil {
      updateShadowLayer()
    } else {
      shadowLayer?.removeFromSuperlayer()
      shadowLayer = nil
    }
  }

  override func layout() {
    super.layout()
    updateShadowLayer()
    disableFocusRings(self)
  }

  private func updateShadowLayer() {
    guard let parentLayer = superview?.layer, let myLayer = self.layer else { return }

    // Parent must not clip so the shadow is visible outside our bounds
    parentLayer.masksToBounds = false

    if shadowLayer == nil {
      let sl = CALayer()
      sl.shadowColor = NSColor.black.cgColor
      sl.shadowOpacity = 0.15
      sl.shadowRadius = 30
      sl.shadowOffset = CGSize(width: 0, height: -2)
      parentLayer.insertSublayer(sl, below: myLayer)
      shadowLayer = sl
    }

    shadowLayer?.frame = myLayer.frame
    shadowLayer?.cornerRadius = cornerRadius
    shadowLayer?.cornerCurve = .continuous
    shadowLayer?.shadowPath = CGPath(
      roundedRect: CGRect(origin: .zero, size: myLayer.frame.size),
      cornerWidth: cornerRadius,
      cornerHeight: cornerRadius,
      transform: nil
    )
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
