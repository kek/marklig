package se.karleklund.marklig

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Cold-launch ACTION_VIEW / ACTION_SEND from the share sheet arrives in
    // the launch intent here, not in onNewIntent. WryActivity (our parent
    // class) only forwards onNewIntent to Rust — the launch intent is
    // dropped on the floor. Replay it through the same path so the
    // deep-link plugin sees it on cold start.
    val launch = intent
    if (launch != null && (launch.data != null || launch.clipData != null)) {
      onNewIntent(launch)
    }

    // Issue #96: Android system back button must drive the JS mobile
    // router rather than exit the app. WryActivity's default callback
    // checks `mWebView.canGoBack()`, but the SPA never builds webview
    // history (routes swap inner content), so the default always falls
    // through to `finish()` — i.e. exit. Register a higher-priority
    // callback that forwards the press to JS via a known global, and
    // backgrounds the app only if JS reports it could not handle it.
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val webView = findWebView()
          if (webView == null) {
            // Webview not up yet (very early in launch). Fall back to
            // the platform default: background the task rather than
            // killing the process, so we don't lose deep-link state.
            moveTaskToBack(true)
            return
          }
          webView.evaluateJavascript(
            "!!(window.__marklig_android_back && window.__marklig_android_back())",
            { result ->
              // `evaluateJavascript` JSON-encodes the result, so a boolean
              // arrives as the literal string "true" or "false". Anything
              // else — null, "null", a parse error, a missing handler —
              // is treated as unhandled, so the user always has a way
              // out of the app even if JS is broken.
              val handled = result == "true"
              if (!handled) {
                moveTaskToBack(true)
              }
            },
          )
        }
      },
    )
  }

  /**
   * WryActivity holds the webview as `mWebView` but doesn't expose it as
   * a protected field on every release. Walk the decor view instead —
   * there is only one WebView in the activity. Returns null if Wry has
   * not attached the webview yet.
   */
  private fun findWebView(): WebView? {
    val root = window?.decorView ?: return null
    return findWebViewIn(root)
  }

  private fun findWebViewIn(view: android.view.View): WebView? {
    if (view is WebView) return view
    if (view is android.view.ViewGroup) {
      for (i in 0 until view.childCount) {
        val hit = findWebViewIn(view.getChildAt(i))
        if (hit != null) return hit
      }
    }
    return null
  }
}
