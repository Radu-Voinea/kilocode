package ai.kilocode.client.review

import ai.kilocode.client.plugin.KiloBundle
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.ComponentInlayAlignment
import com.intellij.openapi.editor.ComponentInlayRenderer
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.InlayProperties
import com.intellij.openapi.editor.addComponentInlay
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.EditorMouseEvent
import com.intellij.openapi.editor.event.EditorMouseListener
import com.intellij.openapi.editor.event.EditorMouseMotionListener
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.util.concurrency.annotations.RequiresEdt
import javax.swing.Icon

/**
 * Review comments in one diff editor: a "+" in the gutter of the hovered line opens a draft card
 * under it, saved comments of this file show as cards under their lines, and cards follow the
 * review's changes in [KiloReviewService].
 */
internal class ReviewEditorBinding(
    private val project: Project,
    private val surface: ReviewSurface,
    parent: Disposable,
) : Disposable {
    private val editor = surface.editor
    private val service = project.service<KiloReviewService>()
    private val cards = HashMap<Long, Pair<ReviewComment, Inlay<*>>>()
    private var draft: Inlay<*>? = null
    private var hover: RangeHighlighter? = null
    private var hoverLine = -1
    private var scheduled = false
    // A press on the "+" that is then dragged picks a range of lines, as on GitHub.
    private var anchor = -1
    private var dragged = false
    private var skipClick = false

    init {
        Disposer.register(parent, this)
        editor.putUserData(ReviewSurface.KEY, surface)
        editor.putUserData(KEY, this)
        editor.addEditorMouseMotionListener(object : EditorMouseMotionListener {
            override fun mouseMoved(e: EditorMouseEvent) = hoverAt(e.logicalPosition.line.takeIf { e.isOverText || e.area != null } ?: -1)

            override fun mouseDragged(e: EditorMouseEvent) {
                if (anchor < 0) return
                dragTo(e.logicalPosition.line)
                e.consume()
            }
        }, this)
        editor.addEditorMouseListener(object : EditorMouseListener {
            override fun mouseExited(event: EditorMouseEvent) {
                if (anchor < 0) hoverAt(-1)
            }

            override fun mousePressed(event: EditorMouseEvent) {
                skipClick = false
                val mouse = event.mouseEvent
                if (event.area != com.intellij.openapi.editor.event.EditorMouseEventArea.LINE_MARKERS_AREA) return
                if (mouse.button != java.awt.event.MouseEvent.BUTTON1 || mouse.isPopupTrigger) return
                val line = event.logicalPosition.line
                if (line != hoverLine) return
                anchor = line
                dragged = false
            }

            override fun mouseReleased(event: EditorMouseEvent) {
                if (anchor < 0) return
                val start = anchor
                anchor = -1
                if (!dragged) return
                val end = event.logicalPosition.line
                skipClick = true
                startDraft(minOf(start, end), maxOf(start, end))
                event.consume()
            }
        }, this)
        // The unified view fills its editor after the diff computes; cards and mappings follow it.
        editor.document.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) = schedule()
        }, this)
        service.listen(this) { key -> if (key.isEmpty() || key == surface.scope.key) schedule() }
        render()
    }

    override fun dispose() {
        editor.putUserData(ReviewSurface.KEY, null)
        editor.putUserData(KEY, null)
        clearHover()
        draft?.let { Disposer.dispose(it) }
        draft = null
        for ((_, pair) in cards) Disposer.dispose(pair.second)
        cards.clear()
    }

    /** Opens a draft card for editor lines [first]..[last], clamped to the lines that take comments. */
    @RequiresEdt
    fun startDraft(first: Int, last: Int) {
        val a = surface.locate(first) ?: return
        val b = surface.locate(last)?.takeIf { it.first == a.first } ?: a
        draft?.let { Disposer.dispose(it) }
        val start = minOf(a.second, b.second)
        val end = maxOf(a.second, b.second)
        val endLine = maxOf(first, last)
        val quote = surface.text(minOf(first, last), endLine)
        lateinit var inlay: Inlay<*>
        val card = ReviewCard(
            project, surface.scope, a.first, start, end, null,
            save = { text ->
                Disposer.dispose(inlay)
                draft = null
                service.add(surface.scope, surface.file, a.first, start, end, quote, text)
            },
            cancel = {
                Disposer.dispose(inlay)
                draft = null
            },
            delete = {},
        )
        inlay = place(endLine, card) ?: return
        draft = inlay
        card.focusText()
    }

    private fun place(line: Int, card: ReviewCard): Inlay<*>? {
        val doc = editor.document
        if (line < 0 || line >= doc.lineCount) return null
        val props = InlayProperties().showAbove(false).relatesToPrecedingText(true).priority(1000)
        return editor.addComponentInlay(doc.getLineEndOffset(line), props, card, ComponentInlayAlignment.FIT_VIEWPORT_WIDTH)
    }

    private fun schedule() {
        if (scheduled) return
        scheduled = true
        ApplicationManager.getApplication().invokeLater({
            scheduled = false
            render()
        }, ModalityState.any()) { Disposer.isDisposed(this) || editor.isDisposed }
    }

    /** Brings the cards in line with the saved comments of this file, keeping cards that did not change. */
    @RequiresEdt
    private fun render() {
        if (editor.isDisposed) return
        val items = service.comments(surface.scope, surface.file).associateBy { it.id }
        val iterator = cards.entries.iterator()
        while (iterator.hasNext()) {
            val (id, pair) = iterator.next()
            val now = items[id]
            if (now == pair.first && pair.second.isValid) {
                (pair.second.renderer as? ComponentInlayRenderer<*>)?.component.let { (it as? ReviewCard)?.refreshTarget() }
                continue
            }
            Disposer.dispose(pair.second)
            iterator.remove()
        }
        for (item in items.values) {
            if (cards.containsKey(item.id)) continue
            val line = surface.line(item.side, item.end) ?: continue
            val card = ReviewCard(
                project, surface.scope, item.side, item.start, item.end, item,
                save = { text -> service.update(surface.scope, item.id, text) },
                cancel = {},
                delete = { service.remove(surface.scope, item.id) },
            )
            val inlay = place(line, card) ?: continue
            cards[item.id] = item to inlay
        }
        (draft?.renderer as? ComponentInlayRenderer<*>)?.component.let { (it as? ReviewCard)?.refreshTarget() }
    }

    /** Selects the whole lines from the drag's start to [line], so the range shows while dragging. */
    internal fun dragTo(line: Int) {
        val doc = editor.document
        if (anchor < 0 || doc.lineCount == 0) return
        val last = line.coerceIn(0, doc.lineCount - 1)
        if (last != anchor) dragged = true
        val first = minOf(anchor, last)
        val end = maxOf(anchor, last)
        editor.selectionModel.setSelection(doc.getLineStartOffset(first), doc.getLineEndOffset(end))
    }

    /** Starts a gutter drag on [line], for tests. */
    internal fun pressForTest(line: Int) {
        anchor = line
        dragged = false
    }

    /** Ends a gutter drag on [line], for tests. */
    internal fun releaseForTest(line: Int) {
        val start = anchor
        anchor = -1
        if (!dragged) return
        startDraft(minOf(start, line), maxOf(start, line))
    }

    private fun hoverAt(line: Int) {
        val ok = line >= 0 && surface.locate(line) != null
        val next = if (ok) line else -1
        if (next == hoverLine) return
        clearHover()
        hoverLine = next
        if (next < 0) return
        val doc = editor.document
        val h = editor.markupModel.addRangeHighlighter(
            doc.getLineStartOffset(next), doc.getLineEndOffset(next),
            HighlighterLayer.LAST, null, com.intellij.openapi.editor.markup.HighlighterTargetArea.LINES_IN_RANGE,
        )
        h.gutterIconRenderer = AddIcon(next)
        hover = h
    }

    private fun clearHover() {
        hover?.let { editor.markupModel.removeHighlighter(it) }
        hover = null
        hoverLine = -1
    }

    /** Opens a draft for the selection, or the caret line. */
    @RequiresEdt
    fun startDraftAtCaret() {
        val (first, last) = range(editor.caretModel.logicalPosition.line)
        startDraft(first, last)
    }

    internal companion object {
        val KEY: com.intellij.openapi.util.Key<ReviewEditorBinding> = com.intellij.openapi.util.Key.create("kilo.review.binding")
    }

    /** First and last editor lines of the selection when it covers [line], else just [line]. */
    private fun range(line: Int): Pair<Int, Int> {
        val model = editor.selectionModel
        if (!model.hasSelection()) return line to line
        val doc = editor.document
        val first = doc.getLineNumber(model.selectionStart)
        var last = doc.getLineNumber(model.selectionEnd)
        if (last > first && model.selectionEnd == doc.getLineStartOffset(last)) last -= 1
        return if (line in first..last) first to last else line to line
    }

    private inner class AddIcon(private val line: Int) : GutterIconRenderer() {
        override fun getIcon(): Icon = AllIcons.General.Add

        override fun getTooltipText(): String = KiloBundle.message("review.gutter.add")

        override fun isNavigateAction(): Boolean = true

        override fun getAlignment(): Alignment = Alignment.LEFT

        override fun getClickAction(): AnAction = object : DumbAwareAction() {
            override fun actionPerformed(e: AnActionEvent) {
                // A drag already opened its range draft on release.
                if (skipClick) {
                    skipClick = false
                    return
                }
                val (first, last) = range(line)
                startDraft(first, last)
            }
        }

        override fun equals(other: Any?): Boolean = other is AddIcon && other.line == line

        override fun hashCode(): Int = line
    }
}
