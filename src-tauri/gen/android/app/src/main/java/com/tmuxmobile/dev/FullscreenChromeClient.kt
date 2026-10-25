package com.tmuxmobile.dev

import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

// Element fullscreen in the Android app (board #454). wry's RustWebChromeClient
// cancels every custom view at once (onShowCustomView calls
// callback.onCustomViewHidden()), it is a final class, and its Kotlin is
// regenerated from the wry crate on every build. So the app WRAPS it: this
// client hosts the custom view and forwards every other method wry overrides
// to wry's own client. `npm run build:android`'s android-env preflight fails
// when the locked wry overrides a method this file does not (scripts/
// wry-chrome-client.mjs) — a dropped onShowFileChooser would be a dead
// attachment picker, silently.
class FullscreenChromeClient(
  val activity: AppCompatActivity,
  private val inner: WebChromeClient,
) : WebChromeClient() {
  private var frame: FrameLayout? = null
  private var hidden: WebChromeClient.CustomViewCallback? = null
  /** The bars as they were before the first show, restored exactly by the
   * one hide path (review P2-C); a refused second show never touches it. */
  private var before: BarSnapshot? = null

  // The back gesture leaves fullscreen first. Added after wry's go-back
  // callback, so it runs before it; enabled only while a view is shown.
  private val back = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() { exit() }
  }

  init {
    activity.onBackPressedDispatcher.addCallback(activity, back)
    // An activity that dies with a view shown takes the decor with it; tell
    // the page so its fullscreen state does not outlive the host.
    activity.lifecycle.addObserver(LifecycleEventObserver { _, event ->
      if (event == Lifecycle.Event.ON_DESTROY) exit()
    })
  }

  private fun bars() = WindowCompat.getInsetsController(activity.window, activity.window.decorView)

  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    if (frame != null) { callback.onCustomViewHidden(); return }
    val host = FrameLayout(activity).apply { setBackgroundColor(Color.BLACK) }
    host.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    (activity.window.decorView as ViewGroup).addView(host, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    frame = host
    hidden = callback
    val insets = ViewCompat.getRootWindowInsets(activity.window.decorView)
    before = BarSnapshot(
      insets?.isVisible(WindowInsetsCompat.Type.statusBars()) ?: true,
      insets?.isVisible(WindowInsetsCompat.Type.navigationBars()) ?: true,
      bars().systemBarsBehavior,
    )
    // Orientation is left to the sensor: a forced landscape would fight a
    // portrait video. The manifest's configChanges keep a rotation from
    // recreating the activity.
    bars().apply {
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      hide(WindowInsetsCompat.Type.systemBars())
    }
    back.isEnabled = true
  }

  /** The HOST ends fullscreen: hide, then tell the page (which may answer
   * with onHideCustomView — hide() is then a no-op). */
  private fun exit() {
    val callback = hidden
    hide()
    callback?.onCustomViewHidden()
  }

  /** The page left fullscreen (exitFullscreen, or after our callback). */
  override fun onHideCustomView() { hide() }

  private fun hide() {
    val host = frame ?: return
    frame = null
    hidden = null
    back.isEnabled = false
    (activity.window.decorView as ViewGroup).removeView(host)
    host.removeAllViews()
    val was = before ?: return
    before = null
    val (shown, hidden) = was.masks(WindowInsetsCompat.Type.statusBars(), WindowInsetsCompat.Type.navigationBars())
    bars().apply {
      systemBarsBehavior = was.behavior
      if (shown != 0) show(shown)
      if (hidden != 0) hide(hidden)
    }
  }

  // Everything else is wry's.
  override fun onPermissionRequest(request: PermissionRequest) = inner.onPermissionRequest(request)
  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean =
    inner.onJsAlert(view, url, message, result)
  override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean =
    inner.onJsConfirm(view, url, message, result)
  override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String, result: JsPromptResult): Boolean =
    inner.onJsPrompt(view, url, message, defaultValue, result)
  override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
    inner.onGeolocationPermissionsShowPrompt(origin, callback)
  override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean =
    inner.onShowFileChooser(webView, filePathCallback, fileChooserParams)
  override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean = inner.onConsoleMessage(consoleMessage)
  override fun onReceivedTitle(view: WebView, title: String) = inner.onReceivedTitle(view, title)
}

/** The page's ONE question (`window.AndroidFullscreen.available()`): is the
 * custom-view host really installed in THIS activity's current WebView?
 * Attached in onWebViewCreate, because an interface added after the page
 * loaded is invisible until the next load. The answer and the whole install
 * flow are [FullscreenReadiness] (request in onWebViewCreate, install after
 * wry's setup, read-back on the next frame, revoked on destroy; review
 * P1-A); this class only backs its [FullscreenPlatform] with the WebView.
 * Every failure answers false (no fullscreen control) and logs one line
 * naming why — fail closed, never a half install. */
class FullscreenHost(private val activity: AppCompatActivity) {
  private val readiness = FullscreenReadiness(object : FullscreenPlatform<WebView> {
    override fun post(view: WebView, run: () -> Unit) { view.post(run) }
    override fun nextFrame(view: WebView, run: () -> Unit) { view.postOnAnimation(run) }
    override fun alive() = !activity.isDestroyed
    override fun wrap(view: WebView): Result<Any> {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O
        && !WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_CHROME_CLIENT)) {
        return failure("this WebView cannot report its chrome client")
      }
      val existing = WebViewCompat.getWebChromeClient(view)
        ?: return failure("wry installed no chrome client before the post")
      return when {
        // The same WebView hooked again: no second layer.
        existing is FullscreenChromeClient && existing.activity === activity -> Result.success(existing)
        existing is FullscreenChromeClient -> failure("the WebView holds another activity's wrapper")
        existing.javaClass.simpleName != "RustWebChromeClient" ->
          failure("the chrome client is ${existing.javaClass.name}, not wry's RustWebChromeClient")
        else -> Result.success(FullscreenChromeClient(activity, existing).also { view.webChromeClient = it })
      }
    }
    override fun holds(view: WebView, wrapper: Any) = WebViewCompat.getWebChromeClient(view) === wrapper
    override fun notify(view: WebView) {
      view.evaluateJavascript("window.dispatchEvent(new Event('androidfullscreenchange'))", null)
    }
    override fun log(why: String) { Log.w("tmux-mobile", "fullscreen host not installed (#454): $why") }
  })

  @JavascriptInterface
  fun available(): Boolean = readiness.ready

  /** onWebViewCreate, synchronously: the request for this WebView. */
  fun attach(webView: WebView) = readiness.attach(webView)

  /** onDestroy: nothing answers true again, nothing in flight lands. */
  fun release() = readiness.release()

  private fun failure(why: String): Result<Any> = Result.failure(IllegalStateException(why))
}
