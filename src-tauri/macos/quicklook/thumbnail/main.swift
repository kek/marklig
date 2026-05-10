// Entry point for the Quick Look thumbnail .appex bundle. See
// preview/main.swift for why we forward-declare `NSExtensionMain` ourselves.

import Foundation

@_silgen_name("NSExtensionMain")
func NSExtensionMain() -> Int32

_ = NSExtensionMain()
