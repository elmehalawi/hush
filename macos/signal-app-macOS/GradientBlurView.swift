import AppKit
import QuartzCore
import CoreImage

@objc(GradientBlurWrapperView) class GradientBlurWrapperView: RCTUIView {
  private var didSetup = false

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.masksToBounds = true
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layout() {
    super.layout()
    guard bounds.height > 0, bounds.width > 0 else { return }

    if !didSetup {
      didSetup = true
      setupVariableBlur()
    }

    // Update sublayer frames on layout
    if let sublayers = layer?.sublayers {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      for sublayer in sublayers {
        sublayer.frame = bounds
      }
      CATransaction.commit()
    }
  }

  private func setupVariableBlur() {
    guard let rootLayer = layer else { return }

    // Try creating a CABackdropLayer directly (private class)
    guard let backdropClass = NSClassFromString("CABackdropLayer") as? CALayer.Type else {
      print("[GradientBlur] CABackdropLayer not available, falling back")
      setupFallback()
      return
    }

    let backdrop = backdropClass.init()
    backdrop.frame = bounds
    backdrop.setValue(true, forKey: "allowsGroupBlending")

    // Create the variableBlur filter
    guard let filterClass = NSClassFromString("CAFilter") as? NSObject.Type else {
      print("[GradientBlur] CAFilter not available, falling back")
      setupFallback()
      return
    }

    let selector = NSSelectorFromString("filterWithType:")
    guard filterClass.responds(to: selector),
          let result = filterClass.perform(selector, with: "variableBlur"),
          let variableBlur = result.takeUnretainedValue() as? NSObject else {
      print("[GradientBlur] variableBlur filter not available, falling back")
      setupFallback()
      return
    }

    guard let maskImage = makeGradientMaskImage(width: 64, height: 64) else {
      print("[GradientBlur] Failed to create mask image, falling back")
      setupFallback()
      return
    }

    variableBlur.setValue(4.0, forKey: "inputRadius")
    variableBlur.setValue(maskImage, forKey: "inputMaskImage")
    variableBlur.setValue(true, forKey: "inputNormalizeEdges")

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    backdrop.filters = [variableBlur]
    rootLayer.addSublayer(backdrop)
    CATransaction.commit()

    print("[GradientBlur] Variable blur applied via direct CABackdropLayer!")
  }

  private func makeGradientMaskImage(width: Int, height: Int) -> CGImage? {
    let gradient = CIFilter(name: "CILinearGradient")!
    // Core Image/macOS: y=0 is bottom, y=height is top
    // alpha=0 at bottom (no blur), alpha=1 at top (full blur)
    gradient.setValue(CIVector(x: 0, y: 0), forKey: "inputPoint0")
    gradient.setValue(CIColor(red: 0, green: 0, blue: 0, alpha: 0), forKey: "inputColor0")
    gradient.setValue(CIVector(x: 0, y: CGFloat(height)), forKey: "inputPoint1")
    gradient.setValue(CIColor.black, forKey: "inputColor1")

    guard let outputImage = gradient.outputImage else { return nil }
    let context = CIContext(options: nil)
    return context.createCGImage(
      outputImage,
      from: CGRect(x: 0, y: 0, width: width, height: height)
    )
  }

  // MARK: - Fallback: gradient opacity mask over blur

  private func setupFallback() {
    let effectView = NSVisualEffectView()
    effectView.blendingMode = .withinWindow
    effectView.material = .headerView
    effectView.state = .active
    effectView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(effectView)
    NSLayoutConstraint.activate([
      effectView.leadingAnchor.constraint(equalTo: leadingAnchor),
      effectView.trailingAnchor.constraint(equalTo: trailingAnchor),
      effectView.topAnchor.constraint(equalTo: topAnchor),
      effectView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])

    effectView.wantsLayer = true
    guard let effectLayer = effectView.layer else { return }

    let mask = CAGradientLayer()
    mask.frame = bounds
    mask.colors = [
      NSColor.white.withAlphaComponent(0.6).cgColor,
      NSColor.clear.cgColor,
    ]
    mask.locations = [0.0, 1.0]
    mask.startPoint = CGPoint(x: 0.5, y: 1)
    mask.endPoint = CGPoint(x: 0.5, y: 0)

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    effectLayer.mask = mask
    CATransaction.commit()
  }
}
