package com.tmuxmobile.dev

/** What [FullscreenReadiness] needs from Android, so the whole request →
 * queue → install → read-back flow runs in the JVM tests (src/test) against a
 * fake. `FullscreenHost` backs it with the WebView and the activity. */
interface FullscreenPlatform<V : Any> {
  /** After wry's own setup (wry sets its chrome client AFTER onWebViewCreate). */
  fun post(view: V, run: () -> Unit)
  /** The next frame, for the read-back. */
  fun nextFrame(view: V, run: () -> Unit)
  fun alive(): Boolean
  /** Put the wrapper in [view] (or find ours there); a failure names why. */
  fun wrap(view: V): Result<Any>
  fun holds(view: V, wrapper: Any): Boolean
  /** Tell [view]'s page the answer changed (`androidfullscreenchange`). */
  fun notify(view: V)
  fun log(why: String)
}

/** The ONE readiness fact behind `AndroidFullscreen.available()` (board
 * #454 review P1-A). A REQUEST is made synchronously when a WebView is
 * created ([attach]): that view becomes the current one, the previous answer
 * is withdrawn at once, and the request gets its ticket. The posted install
 * and its next-frame read-back both carry that ticket and do nothing unless
 * it is still the current request of a live host — a stale task neither
 * wraps, nor publishes, nor takes the current view back. [release]
 * (onDestroy) revokes the answer and cancels everything in flight. Every
 * flip tells the CURRENT view's page. Main thread, except [ready], which the
 * JS bridge thread reads. */
class FullscreenReadiness<V : Any>(private val platform: FullscreenPlatform<V>) {
  @Volatile
  var ready: Boolean = false
    private set
  private var attempt = 0
  private var released = false
  private var view: V? = null

  fun attach(view: V) {
    this.view = view
    attempt += 1
    val ticket = attempt
    publish(false)
    if (released) return
    platform.post(view) { install(view, ticket) }
  }

  fun release() {
    released = true
    attempt += 1
    publish(false)
    view = null
  }

  /** release() and every new request bump the attempt: one comparison is
   * "still the current request of a live host". */
  private fun current(ticket: Int) = ticket == attempt

  private fun install(view: V, ticket: Int) {
    if (!current(ticket)) return
    if (!platform.alive()) return settle(ticket, false, "the activity is gone")
    val wrapper = platform.wrap(view).getOrElse { return settle(ticket, false, it.message ?: "not installed") }
    platform.nextFrame(view) {
      settle(ticket, platform.alive() && platform.holds(view, wrapper), "the wrapper was replaced after install")
    }
  }

  private fun settle(ticket: Int, installed: Boolean, why: String) {
    if (!current(ticket)) return
    publish(installed)
    if (!installed) platform.log(why)
  }

  private fun publish(value: Boolean) {
    if (ready == value) return
    ready = value
    view?.let(platform::notify)
  }
}

/** The system bars before fullscreen (review P2-C): the one hide path puts
 * BOTH halves back — shows what was shown and hides what was hidden — so a
 * bar the user swiped in, or the system showed, during fullscreen does not
 * outlive it. Pure, for the JVM tests. */
class BarSnapshot(val status: Boolean, val navigation: Boolean, val behavior: Int) {
  /** The (show, hide) type masks that restore exactly this snapshot. */
  fun masks(statusType: Int, navigationType: Int): Pair<Int, Int> {
    val show = (if (status) statusType else 0) or (if (navigation) navigationType else 0)
    val hide = (if (status) 0 else statusType) or (if (navigation) 0 else navigationType)
    return show to hide
  }
}
