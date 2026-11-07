package ai.kilocode.client.actions

import ai.kilocode.client.KiloNotifications
import ai.kilocode.client.app.KiloSessionService
import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.telemetry.Telemetry
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.progress.runBlockingCancellable
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.vcs.FilePath
import com.intellij.openapi.vcs.ProjectLevelVcsManager
import com.intellij.openapi.vcs.VcsDataKeys
import com.intellij.openapi.vcs.changes.Change
import com.intellij.openapi.vcs.ui.Refreshable
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.vcs.commit.CommitWorkflowUi
import java.nio.file.InvalidPathException
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean

/**
 * "Generate Commit Message with Kilo" in the commit message toolbar. Sends the changes included in
 * the commit to the Kilo CLI's commit message generator and puts the result into the message box;
 * pressing it again with a message already there asks for a different one.
 */
class GenerateCommitMessageAction : DumbAwareAction() {
    private val running = AtomicBoolean(false)

    override fun getActionUpdateThread() = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        val visible = e.project != null && e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL) != null
        e.presentation.isVisible = visible
        e.presentation.isEnabled = visible && !running.get()
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val control = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL) ?: return
        val request = commitMessageRequest(project, e.getData(VcsDataKeys.COMMIT_WORKFLOW_UI), e.getData(Refreshable.PANEL_KEY))
            ?: return KiloNotifications.error(project, KiloBundle.message("commitMessage.failed"), KiloBundle.message("commitMessage.noRepository"))
        val previous = currentText(e.getData(VcsDataKeys.COMMIT_WORKFLOW_UI), e.getData(Refreshable.PANEL_KEY))
        if (!running.compareAndSet(false, true)) return
        Telemetry.send("Commit Message Generate Clicked", mapOf("regenerate" to (previous != null).toString()))
        object : Task.Backgroundable(project, KiloBundle.message("commitMessage.progress"), true) {
            override fun run(indicator: ProgressIndicator) {
                val text = runBlockingCancellable {
                    service<KiloSessionService>().generateCommitMessage(request.root, request.files, previous)
                }
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) control.setCommitMessage(text)
                }
            }

            override fun onThrowable(error: Throwable) {
                KiloNotifications.error(project, KiloBundle.message("commitMessage.failed"), error.message ?: error.javaClass.simpleName)
            }

            override fun onFinished() {
                running.set(false)
            }
        }.queue()
    }

    private fun currentText(workflow: CommitWorkflowUi?, panel: Refreshable?): String? =
        (workflow?.commitMessageUi?.text ?: (panel as? com.intellij.openapi.vcs.CheckinProjectPanel)?.commitMessage)
            ?.takeIf { it.isNotBlank() }
}

/** The repository to describe and its files (relative to it, as git prints them) that the commit includes. */
internal data class CommitMessageRequest(val root: String, val files: List<String>)

internal fun commitMessageRequest(project: Project, workflow: CommitWorkflowUi?, panel: Refreshable?): CommitMessageRequest? {
    val changes: Collection<Change> = workflow?.getIncludedChanges()
        ?: (panel as? com.intellij.openapi.vcs.CheckinProjectPanel)?.selectedChanges
        ?: emptyList()
    val paths = changes.mapNotNull { (it.afterRevision ?: it.beforeRevision)?.file } +
        (workflow?.getIncludedUnversionedFiles() ?: emptyList())
    val vcs = ProjectLevelVcsManager.getInstance(project)
    val roots = paths.mapNotNull { path -> vcs.getVcsRootFor(path)?.let { it to path } }
    val root: VirtualFile = roots.groupingBy { it.first }.eachCount().maxByOrNull { it.value }?.key
        ?: vcs.allVersionedRoots.firstOrNull()
        ?: return null
    return CommitMessageRequest(root.path, relativeFiles(root.path, roots.filter { it.first == root }.map { it.second }))
}

internal fun relativeFiles(root: String, paths: List<FilePath>): List<String> {
    val base = try {
        Path.of(root).normalize()
    } catch (_: InvalidPathException) {
        return emptyList()
    }
    return paths.mapNotNull { path ->
        try {
            val file = Path.of(path.path).normalize()
            if (file.startsWith(base)) base.relativize(file).toString().replace('\\', '/') else null
        } catch (_: InvalidPathException) {
            null
        }
    }.filter { it.isNotEmpty() }.distinct()
}
