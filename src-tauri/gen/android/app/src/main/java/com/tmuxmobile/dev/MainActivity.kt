package com.tmuxmobile.dev

import android.os.Bundle
import android.graphics.Rect
import android.content.Intent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.content.FileProvider
import java.io.File

class MainActivity : TauriActivity() {
  private val fileOpener = FileOpener()
  private val fullscreen = FullscreenHost(this)
  private var appWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // Wry calls this before the initial page load. addJavascriptInterface
    // only becomes visible to JavaScript after a page load, so attaching here
    // is required; finding the WebView later from onCreate is already too late.
    appWebView = webView
    webView.addJavascriptInterface(fileOpener, "AndroidFileOpener")
    // Element fullscreen (board #454): the interface and the request now
    // (this WebView is current, the old answer is withdrawn); the install
    // runs after wry's own setup, and available() stays false until it is
    // read back.
    webView.addJavascriptInterface(fullscreen, "AndroidFullscreen")
    fullscreen.attach(webView)
  }

  override fun onResume() {
    super.onResume()
    appWebView?.post {
      appWebView?.addJavascriptInterface(fileOpener, "AndroidFileOpener")
      appWebView?.addJavascriptInterface(fullscreen, "AndroidFullscreen")
    }
  }

  override fun onDestroy() {
    fullscreen.release()
    appWebView = null
    super.onDestroy()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val rootView = window.decorView.rootView
    val density = resources.displayMetrics.density

    // Send status bar + navigation bar insets to WebView (convert to CSS px)
    ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val satCss = (systemBars.top / density).toInt()
      val sabCss = (systemBars.bottom / density).toInt()
      val webView = findWebView(rootView)
      webView?.evaluateJavascript("""
        document.documentElement.style.setProperty('--sat', '${satCss}px');
        document.documentElement.style.setProperty('--sab', '${sabCss}px');
      """.trimIndent(), null)
      insets
    }

    // Keyboard height detection (convert to CSS px)
    var lastKeyboardCss = 0
    rootView.viewTreeObserver.addOnGlobalLayoutListener {
      val rect = Rect()
      rootView.getWindowVisibleDisplayFrame(rect)
      val screenHeight = rootView.height
      val keyboardPx = screenHeight - rect.bottom
      val keyboardCss = (keyboardPx / density).toInt()
      if (keyboardCss == lastKeyboardCss) return@addOnGlobalLayoutListener
      lastKeyboardCss = keyboardCss
      val webView = findWebView(rootView)
      val height = if (keyboardCss > 80) keyboardCss else 0
      webView?.evaluateJavascript("""
        window.__ANDROID_KEYBOARD_HEIGHT__ = $height;
        window.__dbg?.('android kb: keyboardPx=$keyboardPx keyboardCss=$keyboardCss height=$height screenH=${screenHeight} rectB=${rect.bottom} density=$density');
        window.dispatchEvent(new CustomEvent('androidKeyboardHeight', { detail: { height: $height } }));
      """.trimIndent(), null)
    }
  }

  private fun findWebView(view: android.view.View): android.webkit.WebView? {
    if (view is android.webkit.WebView) return view
    if (view is android.view.ViewGroup) {
      for (i in 0 until view.childCount) {
        val found = findWebView(view.getChildAt(i))
        if (found != null) return found
      }
    }
    return null
  }

  inner class FileOpener {
    @JavascriptInterface
    fun ping(): String = "ok"

    @JavascriptInterface
    fun openFile(filePath: String): String {
      return try {
        val file = File(filePath)
        if (!file.exists()) return "File not found: $filePath"
        val uri = FileProvider.getUriForFile(
          this@MainActivity,
          "${applicationContext.packageName}.fileprovider",
          file
        )
        val mime = contentResolver.getType(uri) ?: "*/*"
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(uri, mime)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(intent)
        "ok"
      } catch (e: Exception) {
        e.message ?: "unknown error"
      }
    }
  }
}
