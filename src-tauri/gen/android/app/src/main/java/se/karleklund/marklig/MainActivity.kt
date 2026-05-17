package se.karleklund.marklig

import android.os.Bundle
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
  }
}
