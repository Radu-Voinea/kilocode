package ai.kilocode.client.review

import ai.kilocode.client.diff.DIFF_FILE_KEY
import com.intellij.diff.DiffContext
import com.intellij.diff.DiffExtension
import com.intellij.diff.FrameDiffTool
import com.intellij.diff.contents.DocumentContent
import com.intellij.diff.requests.DiffRequest
import com.intellij.diff.tools.fragmented.UnifiedDiffViewer
import com.intellij.diff.tools.util.side.OnesideTextDiffViewer
import com.intellij.diff.tools.util.side.TwosideTextDiffViewer
import com.intellij.diff.util.Side
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.util.Key

/** The review a Kilo diff request belongs to; requests without it (other diffs in the IDE) get no review UI. */
internal val REVIEW_SCOPE_KEY: Key<ReviewScope> = Key.create("kilo.review.scope")

/** Adds review comments to the editors of Kilo diff viewers (session, uncommitted and branch diffs). */
class ReviewDiffExtension : DiffExtension() {
    override fun onViewerCreated(viewer: FrameDiffTool.DiffViewer, context: DiffContext, request: DiffRequest) {
        val scope = request.getUserData(REVIEW_SCOPE_KEY) ?: return
        val file = request.getUserData(DIFF_FILE_KEY) ?: return
        val project = context.project ?: return
        val surfaces = when (viewer) {
            is TwosideTextDiffViewer -> listOf(
                SideSurface(viewer.editor1, scope, file, ReviewSide.OLD, viewer.content1),
                SideSurface(viewer.editor2, scope, file, ReviewSide.NEW, viewer.content2),
            )
            is OnesideTextDiffViewer -> listOf(
                SideSurface(
                    viewer.editor, scope, file,
                    if (viewer.side == Side.LEFT) ReviewSide.OLD else ReviewSide.NEW,
                    viewer.content as? DocumentContent,
                ),
            )
            is UnifiedDiffViewer -> listOf(UnifiedSurface(viewer.editor, scope, file, viewer))
            else -> emptyList()
        }
        for (surface in surfaces) ReviewEditorBinding(project, surface, viewer)
    }
}

/** Editor action: comment on the selected lines, or the caret line, of a Kilo diff. */
class AddReviewCommentAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabledAndVisible = editor?.getUserData(ReviewEditorBinding.KEY) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        editor.getUserData(ReviewEditorBinding.KEY)?.startDraftAtCaret()
    }
}
