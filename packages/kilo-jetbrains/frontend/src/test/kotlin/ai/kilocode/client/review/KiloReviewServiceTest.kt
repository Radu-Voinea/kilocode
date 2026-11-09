package ai.kilocode.client.review

import ai.kilocode.client.diff.diffRequest
import ai.kilocode.rpc.dto.DiffFileDto
import com.intellij.diff.contents.DocumentContent
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class KiloReviewServiceTest : BasePlatformTestCase() {
    private val scope = ReviewScope(directory = "/repo/.kilo/worktrees/fix", source = "session", sessionId = "s2", title = "Changes")

    private class Handle(
        override val sessionId: String?,
        override val directory: String,
        override val title: String?,
        override val readonly: Boolean = false,
    ) : ReviewSessionHandle {
        val sent = ArrayList<String>()
        override fun submit(text: String, title: String) {
            sent += text
        }
    }

    override fun tearDown() {
        try {
            project.service<KiloReviewService>().discard(scope)
        } finally {
            super.tearDown()
        }
    }

    fun `test comments are kept per review and file and can be edited and removed`() {
        val service = project.service<KiloReviewService>()
        val a = service.add(scope, "src/A.kt", ReviewSide.NEW, 14, 12, "x\ny\nz", " rename this ")
        service.add(scope, "src/B.kt", ReviewSide.OLD, 3, 3, "old", "why removed?")
        assertEquals(2, service.comments(scope).size)
        assertEquals(12, a.start)
        assertEquals(14, a.end)
        assertEquals("rename this", a.text)
        assertEquals(listOf("src/A.kt"), service.comments(scope, "src/A.kt").map { it.file })

        service.update(scope, a.id, "rename to fooBar")
        assertEquals("rename to fooBar", service.comments(scope, "src/A.kt").single().text)
        service.remove(scope, a.id)
        assertEquals(listOf("src/B.kt"), service.comments(scope).map { it.file })
        assertTrue(service.comments(scope.copy(source = "local")).isEmpty())
    }

    fun `test targets put the diff's own session first and end with the worktree tab`() {
        val service = project.service<KiloReviewService>()
        val other = Handle("s1", scope.directory + "/", "Other")
        val own = Handle("s2", scope.directory, "Own")
        val elsewhere = Handle("s3", "/repo", "Elsewhere")
        val hosted = Handle("s4", scope.directory, "Hosted", readonly = true)
        listOf(other, own, elsewhere, hosted).forEach(service::register)
        try {
            val targets = service.targets(scope)
            assertEquals(3, targets.size)
            assertSame(own, (targets[0] as ReviewTarget.Session).key)
            assertSame(other, (targets[1] as ReviewTarget.Session).key)
            assertTrue(targets[2] is ReviewTarget.Worktree)
            assertSame(own, (service.target(scope) as ReviewTarget.Session).key)

            service.choose(scope, targets[1])
            assertSame(other, (service.target(scope) as ReviewTarget.Session).key)
        } finally {
            listOf(other, own, elsewhere, hosted).forEach(service::unregister)
        }
    }

    fun `test submit sends one prompt to the chosen session and clears the review`() {
        val service = project.service<KiloReviewService>()
        val own = Handle("s2", scope.directory, "Own")
        service.register(own)
        try {
            assertFalse(service.submit(scope))
            service.add(scope, "src/A.kt", ReviewSide.NEW, 3, 4, "val a = 1\nval b = 2", "Merge these")
            service.add(scope, "src/A.kt", ReviewSide.NEW, 1, 1, "package a", "Wrong package")
            var fired = 0
            service.listen(testRootDisposable) { if (it == scope.key) fired++ }
            assertTrue(service.submit(scope))
            assertEquals(1, own.sent.size)
            val text = own.sent.single()
            assertTrue(text, text.contains("## `src/A.kt`"))
            assertTrue(text, text.indexOf("Wrong package") < text.indexOf("Merge these"))
            assertTrue(text.contains("Lines 3–4"))
            assertTrue(service.comments(scope).isEmpty())
            assertTrue(fired > 0)
        } finally {
            service.unregister(own)
        }
    }

    fun `test prompt quotes code with a fence longer than any fence inside it`() {
        val text = reviewPrompt(
            ReviewScope("/repo", "branch", branch = "feature/x"),
            listOf(ReviewComment(1, "README.md", ReviewSide.OLD, 5, 5, "```kotlin", "Keep this example")),
        )
        assertTrue(text, text.contains("branch `feature/x` against its base branch"))
        assertTrue(text, text.contains("### Comment 1 — Line 5 (removed code, old version)"))
        assertTrue(text, text.contains("````markdown\n```kotlin\n````"))
        assertTrue(text, text.endsWith("Keep this example\n"))
    }

    fun `test side surface maps hunk fallback lines to real file lines`() {
        val request = diffRequest(
            project,
            DiffFileDto(
                file = "src/Main.kt",
                additions = 1,
                deletions = 1,
                patch = "--- a/src/Main.kt\n+++ b/src/Main.kt\n@@ -126,3 +126,3 @@\n one\n-two\n+TWO\n three\n",
                status = "modified",
            ),
        ) as SimpleDiffRequest
        val content = request.contents[1] as DocumentContent
        val editor = EditorFactory.getInstance().createViewer(content.document, project) as EditorEx
        try {
            val surface = SideSurface(editor, scope, "src/Main.kt", ReviewSide.NEW, content)
            assertEquals(ReviewSide.NEW to 127, surface.locate(1))
            assertEquals(1, surface.line(ReviewSide.NEW, 127))
            assertNull(surface.line(ReviewSide.OLD, 127))
            assertEquals("TWO", surface.text(1, 1))
        } finally {
            EditorFactory.getInstance().releaseEditor(editor)
        }
    }

    fun `test editor binding shows a card for each saved comment of its file`() {
        val service = project.service<KiloReviewService>()
        val doc = EditorFactory.getInstance().createDocument("a\nb\nc\nd\n")
        val editor = EditorFactory.getInstance().createViewer(doc, project) as EditorEx
        val parent = Disposer.newDisposable(testRootDisposable, "binding")
        try {
            val binding = ReviewEditorBinding(project, SideSurface(editor, scope, "src/A.kt", ReviewSide.NEW, null), parent)
            assertSame(binding, editor.getUserData(ReviewEditorBinding.KEY))
            service.add(scope, "src/A.kt", ReviewSide.NEW, 2, 3, "b\nc", "one")
            service.add(scope, "src/Other.kt", ReviewSide.NEW, 1, 1, "x", "other file")
            com.intellij.util.ui.UIUtil.dispatchAllInvocationEvents()
            val inlays = editor.inlayModel.getBlockElementsInRange(0, doc.textLength)
            assertEquals(1, inlays.size)
            assertEquals(2, doc.getLineNumber(inlays.single().offset))

            binding.startDraft(0, 0)
            assertEquals(2, editor.inlayModel.getBlockElementsInRange(0, doc.textLength).size)
            Disposer.dispose(parent)
            assertTrue(editor.inlayModel.getBlockElementsInRange(0, doc.textLength).isEmpty())
            assertNull(editor.getUserData(ReviewEditorBinding.KEY))
        } finally {
            Disposer.dispose(parent)
            EditorFactory.getInstance().releaseEditor(editor)
        }
    }

    fun `test dragging the gutter plus selects a line range and opens one draft under its last line`() {
        val doc = EditorFactory.getInstance().createDocument("a\nb\nc\nd\n")
        val editor = EditorFactory.getInstance().createViewer(doc, project) as EditorEx
        val parent = Disposer.newDisposable(testRootDisposable, "drag")
        try {
            val binding = ReviewEditorBinding(project, SideSurface(editor, scope, "src/Drag.kt", ReviewSide.NEW, null), parent)
            binding.pressForTest(0)
            binding.dragTo(1)
            binding.dragTo(2)
            assertEquals(doc.getLineStartOffset(0), editor.selectionModel.selectionStart)
            assertEquals(doc.getLineEndOffset(2), editor.selectionModel.selectionEnd)

            binding.releaseForTest(2)
            val inlays = editor.inlayModel.getBlockElementsInRange(0, doc.textLength)
            assertEquals(1, inlays.size)
            assertEquals(2, doc.getLineNumber(inlays.single().offset))
        } finally {
            Disposer.dispose(parent)
            EditorFactory.getInstance().releaseEditor(editor)
        }
    }

    fun `test the plus covers a selection even after the gutter press clears it`() {
        val doc = EditorFactory.getInstance().createDocument("a\nb\nc\nd\n")
        val editor = EditorFactory.getInstance().createViewer(doc, project) as EditorEx
        val parent = Disposer.newDisposable(testRootDisposable, "selection")
        try {
            val binding = ReviewEditorBinding(project, SideSurface(editor, scope, "src/Sel.kt", ReviewSide.NEW, null), parent)
            editor.selectionModel.setSelection(doc.getLineStartOffset(1) + 1, doc.getLineEndOffset(2))
            assertEquals(1 to 2, binding.range(1))
            editor.selectionModel.removeSelection()
            assertEquals(1 to 2, binding.range(2))
            assertEquals(3 to 3, binding.range(3))
        } finally {
            Disposer.dispose(parent)
            EditorFactory.getInstance().releaseEditor(editor)
        }
    }
}
