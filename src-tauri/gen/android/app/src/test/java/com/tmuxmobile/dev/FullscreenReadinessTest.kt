package com.tmuxmobile.dev

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Board #454 review P1-A: the fullscreen capability is the CURRENT live
// request's install, never a stale or late answer — through the whole
// request → queue → install → read-back flow, against a fake platform whose
// posted tasks and frames the test runs in any order.
// `./gradlew :app:testUniversalReleaseUnitTest` in src-tauri/gen/android.
class FullscreenReadinessTest {
  private class Fake : FullscreenPlatform<String> {
    val posted = mutableListOf<Pair<String, () -> Unit>>()
    val frames = mutableListOf<Pair<String, () -> Unit>>()
    var alive = true
    val failWrap = mutableSetOf<String>()
    val wrapped = mutableListOf<String>()
    val installedIn = mutableMapOf<String, Any>()
    val notified = mutableListOf<String>()
    val logs = mutableListOf<String>()
    override fun post(view: String, run: () -> Unit) { posted += view to run }
    override fun nextFrame(view: String, run: () -> Unit) { frames += view to run }
    override fun alive() = alive
    override fun wrap(view: String): Result<Any> {
      if (view in failWrap) return Result.failure(IllegalStateException("no wry client in $view"))
      wrapped += view
      return Result.success(installedIn.getOrPut(view) { "wrapper@$view" })
    }
    override fun holds(view: String, wrapper: Any) = installedIn[view] === wrapper
    override fun notify(view: String) { notified += view }
    override fun log(why: String) { logs += why }
    fun runPost(view: String) { val i = posted.indexOfFirst { it.first == view }; posted.removeAt(i).second() }
    fun runFrame(view: String) { val i = frames.indexOfFirst { it.first == view }; frames.removeAt(i).second() }
    fun runAll(view: String) { runPost(view); if (frames.any { it.first == view }) runFrame(view) }
  }

  private val p = Fake()
  private val r = FullscreenReadiness(p)

  @Test fun aRequestIsReadyOnlyAfterItsInstallIsReadBack() {
    r.attach("A")
    assertFalse(r.ready)
    p.runPost("A")
    assertFalse("installed, not yet read back", r.ready)
    p.runFrame("A")
    assertTrue(r.ready)
    assertEquals(listOf("A"), p.notified)
  }

  @Test fun aNewRequestWithdrawsTheOldAnswerAtOnceAndTellsTheNewPage() {
    r.attach("A"); p.runAll("A")
    r.attach("B")
    assertFalse("B requested, its post not run yet: A's true is gone", r.ready)
    assertEquals(listOf("A", "B"), p.notified)
  }

  @Test fun anOldQueuedInstallRunningAfterTheNewOneNeitherWrapsNorPublishes() {
    r.attach("A")
    r.attach("B")
    p.runAll("B")
    assertTrue(r.ready)
    p.runPost("A")
    assertEquals("A's stale task wrapped nothing", listOf("B"), p.wrapped)
    assertTrue(p.frames.isEmpty())
    assertTrue("and did not take the answer from B", r.ready)
    r.release()
    assertEquals("nor the current view: the revocation reaches B's page, never A's", listOf("B", "B"), p.notified)
  }

  @Test fun anOldReadBackLandingAfterANewRequestIsIgnored() {
    r.attach("A"); p.runPost("A")
    r.attach("B")
    p.runFrame("A")
    assertFalse(r.ready)
    p.runAll("B")
    assertTrue(r.ready)
  }

  @Test fun aFailedNewInstallDoesNotLeaveTheOldTrue() {
    r.attach("A"); p.runAll("A")
    p.failWrap += "B"
    r.attach("B"); p.runPost("B")
    assertFalse(r.ready)
    assertEquals(listOf("no wry client in B"), p.logs)
  }

  @Test fun releaseCancelsEverythingQueuedWithNoInstallSideEffect() {
    r.attach("A")
    r.release()
    p.runPost("A")
    assertTrue("no wrap after release", p.wrapped.isEmpty())
    assertFalse(r.ready)
    r.attach("B")
    assertTrue("a request after release queues nothing", p.posted.isEmpty())
  }

  @Test fun releaseRevokesAndAReadBackInFlightNeverPublishes() {
    r.attach("A"); p.runAll("A")
    r.attach("B"); p.runPost("B")
    r.release()
    p.runFrame("B")
    assertFalse(r.ready)
  }

  @Test fun theActivityGoneAtInstallOrAtReadBackAnswersFalse() {
    r.attach("A"); p.alive = false; p.runPost("A")
    assertFalse(r.ready)
    assertTrue(p.wrapped.isEmpty())
    p.alive = true
    r.attach("B"); p.runPost("B"); p.alive = false; p.runFrame("B")
    assertFalse(r.ready)
  }

  @Test fun aReplacedWrapperAnswersFalse() {
    r.attach("A"); p.runPost("A")
    p.installedIn["A"] = "someone else's client"
    p.runFrame("A")
    assertFalse(r.ready)
    assertEquals(listOf("the wrapper was replaced after install"), p.logs)
  }

  @Test fun anExistingPageSeesTheRevocationAndTheNewReadiness() {
    r.attach("A"); p.runAll("A")
    r.attach("B"); p.runAll("B")
    assertTrue(r.ready)
    assertEquals("true on A; withdrawn, then true, on B", listOf("A", "B", "B"), p.notified)
  }

  @Test fun theBarsComeBackExactlyInAllFourStates() {
    val status = 1; val nav = 2
    assertEquals(3 to 0, BarSnapshot(true, true, 0).masks(status, nav))
    assertEquals(1 to 2, BarSnapshot(true, false, 0).masks(status, nav))
    assertEquals(2 to 1, BarSnapshot(false, true, 0).masks(status, nav))
    assertEquals("both were hidden: a bar swiped in during fullscreen is hidden again", 0 to 3, BarSnapshot(false, false, 0).masks(status, nav))
  }
}
