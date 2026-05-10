// Entry point for the Quick Look preview .appex bundle.
//
// Quick Look extensions are hosted by the system via the C function
// `NSExtensionMain`, which is declared in Foundation's Objective-C headers
// but not re-exported into Swift's Foundation overlay (the overlay assumes
// you'll be using Xcode's `@NSExtensionMain` attribute, which is only
// available when consuming Foundation through Xcode's extension target
// templates). Since this build is hand-rolled, we forward-declare the
// symbol using `@_silgen_name` and call it directly.

import Foundation

@_silgen_name("NSExtensionMain")
func NSExtensionMain() -> Int32

_ = NSExtensionMain()
