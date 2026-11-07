package ai.kilocode.client.review

import com.intellij.diff.contents.DocumentContent
import com.intellij.diff.tools.fragmented.UnifiedDiffViewer
import com.intellij.diff.util.DiffUserDataKeysEx
import com.intellij.diff.util.Side
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.util.Key

/**
 * One editor of a Kilo diff viewer that takes review comments, with the mapping between its editor
 * lines (0-based) and the file lines (1-based, as the gutter shows them) of each diff side.
 */
internal abstract class ReviewSurface(
    val editor: EditorEx,
    val scope: ReviewScope,
    val file: String,
) {
    /** The side and file line of editor line [line], or null when that line takes no comment. */
    abstract fun locate(line: Int): Pair<ReviewSide, Int>?

    /** The editor line that shows file line [line] of [side], or null when this editor does not show it. */
    abstract fun line(side: ReviewSide, line: Int): Int?

    /** The text of editor lines [first]..[last] (0-based, inclusive). */
    fun text(first: Int, last: Int): String {
        val doc = editor.document
        if (doc.lineCount == 0) return ""
        val a = first.coerceIn(0, doc.lineCount - 1)
        val b = last.coerceIn(a, doc.lineCount - 1)
        return doc.charsSequence.subSequence(doc.getLineStartOffset(a), doc.getLineEndOffset(b)).toString()
    }

    internal companion object {
        val KEY: Key<ReviewSurface> = Key.create("kilo.review.surface")
    }
}

/** An editor that shows one side's text as is: side-by-side panes and one-sided (added/deleted file) views. */
internal class SideSurface(
    editor: EditorEx,
    scope: ReviewScope,
    file: String,
    private val side: ReviewSide,
    content: DocumentContent?,
) : ReviewSurface(editor, scope, file) {
    private val convert = content?.getUserData(DiffUserDataKeysEx.LINE_NUMBER_CONVERTOR)

    override fun locate(line: Int): Pair<ReviewSide, Int>? {
        if (line < 0 || line >= editor.document.lineCount) return null
        val real = convert?.applyAsInt(line) ?: line
        if (real < 0) return null
        return side to real + 1
    }

    override fun line(side: ReviewSide, line: Int): Int? {
        if (side != this.side) return null
        val conv = convert ?: return (line - 1).takeIf { it in 0 until editor.document.lineCount }
        for (i in 0 until editor.document.lineCount) if (conv.applyAsInt(i) == line - 1) return i
        return null
    }
}

/** The unified view: one editor that interleaves both sides; unchanged lines count as the new side. */
internal class UnifiedSurface(
    editor: EditorEx,
    scope: ReviewScope,
    file: String,
    private val viewer: UnifiedDiffViewer,
) : ReviewSurface(editor, scope, file) {
    private val left = viewer.getContent(Side.LEFT).getUserData(DiffUserDataKeysEx.LINE_NUMBER_CONVERTOR)
    private val right = viewer.getContent(Side.RIGHT).getUserData(DiffUserDataKeysEx.LINE_NUMBER_CONVERTOR)

    override fun locate(line: Int): Pair<ReviewSide, Int>? {
        if (line < 0 || line >= editor.document.lineCount) return null
        val new = viewer.transferLineFromOnesideStrict(Side.RIGHT, line)
        if (new >= 0) return real(right, new)?.let { ReviewSide.NEW to it }
        val old = viewer.transferLineFromOnesideStrict(Side.LEFT, line)
        if (old >= 0) return real(left, old)?.let { ReviewSide.OLD to it }
        return null
    }

    override fun line(side: ReviewSide, line: Int): Int? {
        val s = if (side == ReviewSide.NEW) Side.RIGHT else Side.LEFT
        val conv = if (side == ReviewSide.NEW) right else left
        val doc = viewer.getDocument(s)
        val index = if (conv == null) line - 1 else (0 until doc.lineCount).firstOrNull { conv.applyAsInt(it) == line - 1 } ?: return null
        return viewer.transferLineToOnesideStrict(s, index).takeIf { it >= 0 }
    }

    private fun real(conv: java.util.function.IntUnaryOperator?, line: Int): Int? {
        val value = conv?.applyAsInt(line) ?: line
        return if (value < 0) null else value + 1
    }
}
