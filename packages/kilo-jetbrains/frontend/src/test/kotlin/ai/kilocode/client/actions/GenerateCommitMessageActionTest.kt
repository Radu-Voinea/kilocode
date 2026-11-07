package ai.kilocode.client.actions

import com.intellij.openapi.vcs.LocalFilePath
import kotlin.test.Test
import kotlin.test.assertEquals

class GenerateCommitMessageActionTest {
    @Test
    fun `files are made relative to the repository like git prints them`() {
        val paths = listOf(
            LocalFilePath("/repo/src/Main.kt", false),
            LocalFilePath("/repo/README.md", false),
            LocalFilePath("/repo/src/Main.kt", false),
            LocalFilePath("/elsewhere/x.kt", false),
            LocalFilePath("/repo", true),
        )

        assertEquals(listOf("src/Main.kt", "README.md"), relativeFiles("/repo", paths))
    }
}
