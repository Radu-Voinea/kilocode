package ai.kilocode.client.settings

import ai.kilocode.client.plugin.KiloBundle
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class WorktreeLocationTextTest : BasePlatformTestCase() {
    fun `test location description keeps the repo placeholder and apostrophe`() {
        val text = KiloBundle.message("settings.advanced.worktreeLocation.description")
        assertTrue(text, text.contains("{repo}"))
        assertTrue(text, text.contains("repository's"))
    }
}
