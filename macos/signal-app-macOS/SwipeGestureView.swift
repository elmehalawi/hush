import AppKit

@objc(SwipeGestureView)
class SwipeGestureView: RCTUIView {
    @objc var onSwipeUpdate: RCTBubblingEventBlock?
    @objc var onSwipeEnd: RCTBubblingEventBlock?

    private enum GestureDirection {
        case undecided
        case horizontal
        case vertical
    }

    private var accumulatedDX: CGFloat = 0
    private var accumulatedDY: CGFloat = 0
    private var direction: GestureDirection = .undecided
    private var gestureEnded = false

    override func scrollWheel(with event: NSEvent) {
        // If no handlers are set, pass everything through
        guard onSwipeUpdate != nil || onSwipeEnd != nil else {
            super.scrollWheel(with: event)
            return
        }

        // Handle direct gesture phases (finger on trackpad)
        if event.phase != [] {
            // Check .ended/.cancelled FIRST — NSEvent.Phase is an OptionSet
            // and could theoretically have multiple bits set
            if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
                if direction == .horizontal {
                    gestureEnded = true
                    onSwipeEnd?(["deltaX": accumulatedDX])
                } else {
                    super.scrollWheel(with: event)
                }
                return
            }

            if event.phase.contains(.began) {
                accumulatedDX = 0
                accumulatedDY = 0
                direction = .undecided
                gestureEnded = false
                return
            }

            if event.phase.contains(.changed) {
                accumulatedDX += event.scrollingDeltaX
                accumulatedDY += event.scrollingDeltaY

                if direction == .undecided {
                    let absX = abs(accumulatedDX)
                    let absY = abs(accumulatedDY)
                    if absX > 5 || absY > 5 {
                        direction = absX >= absY ? .horizontal : .vertical
                    }
                }

                if direction == .horizontal && !gestureEnded {
                    onSwipeUpdate?(["deltaX": accumulatedDX])
                    return
                }

                super.scrollWheel(with: event)
                return
            }

            super.scrollWheel(with: event)
            return
        }

        // Handle momentum phases (inertial scrolling after finger lifts)
        if event.momentumPhase != [] {
            if direction == .horizontal {
                // Suppress momentum — JS spring animation handles deceleration
                if event.momentumPhase.contains(.ended) {
                    direction = .undecided
                    gestureEnded = false
                }
                return
            }

            super.scrollWheel(with: event)

            if event.momentumPhase.contains(.ended) {
                direction = .undecided
                gestureEnded = false
            }
            return
        }

        // Legacy scroll wheel events (non-gesture, e.g. mouse wheel)
        super.scrollWheel(with: event)
    }
}
