import AppKit

@available(macOS 26.0, *)
@objc(GlassContainerWrapperView) class GlassContainerWrapperView: RCTUIView {
  private let containerView = NSGlassEffectContainerView()

  override init(frame: NSRect) {
    super.init(frame: frame)
    containerView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(containerView)
    NSLayoutConstraint.activate([
      containerView.leadingAnchor.constraint(equalTo: leadingAnchor),
      containerView.trailingAnchor.constraint(equalTo: trailingAnchor),
      containerView.topAnchor.constraint(equalTo: topAnchor),
      containerView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func insertReactSubview(_ subview: NSView!, at atIndex: Int) {
    containerView.addSubview(subview)
  }

  override func removeReactSubview(_ subview: NSView!) {
    subview.removeFromSuperview()
  }
}
