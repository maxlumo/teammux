// Board #454 test fixture: the class-level override SIGNATURES of wry
// 0.54.2's RustWebChromeClient.kt, as wry declares them (layout, nullability
// and qualifiers kept), with stand-in bodies. Nested listener objects and a
// brace in a string are here so the parser must tell them apart.
package {{package}}

class RustWebChromeClient(appActivity: WryActivity) : WebChromeClient() {
  private interface PermissionListener {
    fun onPermissionSelect(isGranted: Boolean?)
  }

  private val activity: WryActivity
  init { activity = appActivity; val s = "a } in a string" }

  override fun onShowCustomView(view: View, callback: CustomViewCallback) {
    callback.onCustomViewHidden()
    super.onShowCustomView(view, callback)
  }

  override fun onHideCustomView() {
    super.onHideCustomView()
  }

  override fun onPermissionRequest(request: PermissionRequest) {
    val listener = object : PermissionListener {
      override fun onPermissionSelect(isGranted: Boolean?) {}
    }
  }

  override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
    return true
  }

  override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
    return true
  }

  override fun onJsPrompt(
    view: WebView,
    url: String,
    message: String,
    defaultValue: String,
    result: JsPromptResult
  ): Boolean {
    return true
  }

  override fun onGeolocationPermissionsShowPrompt(
    origin: String,
    callback: GeolocationPermissions.Callback
  ) {
  }

  override fun onShowFileChooser(
    webView: WebView,
    filePathCallback: ValueCallback<Array<Uri?>?>,
    fileChooserParams: FileChooserParams
  ): Boolean {
    return true
  }

  override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
    return true
  }

  override fun onReceivedTitle(
      view: WebView,
      title: String
  ) {
    super.onReceivedTitle(view, title)
  }
}
