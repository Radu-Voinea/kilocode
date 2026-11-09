package ai.kilocode.client.diff

import com.intellij.diff.DiffContext
import com.intellij.diff.DiffExtension
import com.intellij.diff.FrameDiffTool
import com.intellij.diff.requests.DiffRequest
import com.intellij.diff.tools.fragmented.UnifiedDiffViewer
import com.intellij.diff.tools.util.side.OnesideTextDiffViewer
import com.intellij.diff.tools.util.side.TwosideTextDiffViewer
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.IdeActions
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.event.EditorMouseEvent
import com.intellij.openapi.editor.event.EditorMouseListener
import java.awt.event.MouseEvent

/**
 * Shift+click on a symbol in a Kilo diff goes to its declaration, like Ctrl+click. The diff text is tied to
 * the real file (see `diffRequest`), so the IDE can resolve the symbol.
 */
class DiffNavigationExtension : DiffExtension() {
    override fun onViewerCreated(viewer: FrameDiffTool.DiffViewer, context: DiffContext, request: DiffRequest) {
        if (request.getUserData(DIFF_FILE_KEY) == null) return
        val editors = when (viewer) {
            is TwosideTextDiffViewer -> listOf(viewer.editor1, viewer.editor2)
            is OnesideTextDiffViewer -> listOf(viewer.editor)
            is UnifiedDiffViewer -> listOf(viewer.editor)
            else -> emptyList()
        }
        for (editor in editors) editor.addEditorMouseListener(ShiftClick(editor), viewer)
    }

    private class ShiftClick(private val editor: Editor) : EditorMouseListener {
        override fun mouseClicked(event: EditorMouseEvent) {
            val mouse = event.mouseEvent
            if (!shiftClick(mouse)) return
            if (!event.isOverText) return
            mouse.consume()
            event.consume()
            editor.selectionModel.removeSelection()
            editor.caretModel.moveToOffset(event.offset)
            val action = ActionManager.getInstance().getAction(IdeActions.ACTION_GOTO_DECLARATION) ?: return
            ActionManager.getInstance().tryToExecute(action, mouse, editor.contentComponent, ActionPlaces.EDITOR_POPUP, true)
        }
    }
}

internal fun shiftClick(e: MouseEvent): Boolean =
    e.button == MouseEvent.BUTTON1 && e.clickCount == 1 && e.isShiftDown && !e.isControlDown && !e.isAltDown && !e.isMetaDown
