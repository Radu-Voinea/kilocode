package ai.kilocode.client.diff

import ai.kilocode.client.KiloNotifications
import ai.kilocode.client.app.KiloSessionService
import ai.kilocode.client.app.KiloWorkspaceService
import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.rpc.dto.CommitResultDto
import ai.kilocode.rpc.dto.DiffFileDto
import com.intellij.icons.AllIcons
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.ui.AnimatedIcon
import com.intellij.ui.CheckBoxList
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.awt.BorderLayout
import java.awt.FlowLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Commits a worktree's uncommitted changes from the diff view. Lists the changed files (all included at
 * first), and asks Kilo for a message for the included files as soon as they are known; "Generate with
 * Kilo" asks again for a different one. Git hooks run as for any commit; a failure stays in the dialog.
 */
internal class DiffCommitDialog(
    private val project: Project,
    private val directory: String,
    private val cs: CoroutineScope,
    private val committed: (String?) -> Unit,
) : DialogWrapper(project) {
    private val files = CheckBoxList<String>()
    private val message = JBTextArea(6, 60).apply {
        lineWrap = true
        wrapStyleWord = true
        emptyText.text = KiloBundle.message("diff.commit.message.empty")
    }
    private val status = JBLabel().apply { foreground = UIUtil.getContextHelpForeground() }
    private val generate = JButton(KiloBundle.message("diff.commit.generate"), AllIcons.Actions.Lightning).apply {
        addActionListener { generate() }
    }
    private val pushAction = object : DialogWrapperAction(KiloBundle.message("diff.commit.okPush")) {
        override fun doAction(e: java.awt.event.ActionEvent?) = commit(push = true)
    }
    private var paths: List<String> = emptyList()
    private var job: Job? = null
    private var busy = false

    init {
        title = KiloBundle.message("diff.commit.title")
        setOKButtonText(KiloBundle.message("diff.commit.ok"))
        isOKActionEnabled = false
        generate.isEnabled = false
        init()
        load()
    }

    override fun createCenterPanel(): JComponent = JPanel(BorderLayout(0, JBUI.scale(8))).apply {
        val top = JPanel(BorderLayout(0, JBUI.scale(4)))
        top.add(JBLabel(KiloBundle.message("diff.commit.files")), BorderLayout.NORTH)
        top.add(JBScrollPane(files).apply { preferredSize = JBUI.size(560, 180) }, BorderLayout.CENTER)
        add(top, BorderLayout.NORTH)
        val middle = JPanel(BorderLayout(0, JBUI.scale(4)))
        middle.add(JPanel(BorderLayout()).apply {
            add(JBLabel(KiloBundle.message("diff.commit.message")), BorderLayout.WEST)
            add(JPanel(FlowLayout(FlowLayout.RIGHT, 0, 0)).apply { add(generate) }, BorderLayout.EAST)
        }, BorderLayout.NORTH)
        middle.add(JBScrollPane(message), BorderLayout.CENTER)
        add(middle, BorderLayout.CENTER)
        add(status, BorderLayout.SOUTH)
    }

    override fun getPreferredFocusedComponent(): JComponent = message

    override fun createActions(): Array<javax.swing.Action> = arrayOf(okAction, pushAction, cancelAction)

    override fun doValidate(): ValidationInfo? {
        if (paths.isNotEmpty() && selected().isEmpty()) return ValidationInfo(KiloBundle.message("diff.commit.noFiles"), files)
        if (message.text.isBlank()) return ValidationInfo(KiloBundle.message("diff.commit.noMessage"), message)
        return null
    }

    override fun dispose() {
        job?.cancel()
        super.dispose()
    }

    /** The included files, relative to the checkout. */
    internal fun selected(): List<String> = paths.filter { files.isItemSelected(it) }

    internal fun messageText(): String = message.text

    internal fun setMessage(text: String) {
        message.text = text
    }

    internal fun include(path: String, value: Boolean) = files.setItemSelected(path, value)

    internal fun filesForTest(): List<String> = paths

    internal fun commitForTest() = doOKAction()

    internal fun commitAndPushForTest() = commit(push = true)

    private fun load() {
        working(KiloBundle.message("diff.commit.loading"))
        job = cs.launch {
            val changed = runCatching { service<KiloWorkspaceService>().localDiff(directory, patches = false) }
                .getOrElse {
                    if (it is CancellationException) throw it
                    emptyList<DiffFileDto>()
                }
            withContext(Dispatchers.Main) {
                if (isDisposed) return@withContext
                paths = changed.map { it.file }
                files.clear()
                for (file in changed) files.addItem(file.file, label(file), true)
                if (paths.isEmpty()) {
                    idle(KiloBundle.message("diff.commit.nothing"))
                    return@withContext
                }
                idle("")
                isOKActionEnabled = true
                generate.isEnabled = true
                generate()
            }
        }
    }

    private fun label(file: DiffFileDto): String {
        val stats = if (file.additions == 0 && file.deletions == 0) "" else "  +${file.additions} -${file.deletions}"
        val kind = file.status?.takeIf { it != "modified" }?.let { "  ($it)" }.orEmpty()
        return file.file + stats + kind
    }

    @org.jetbrains.annotations.VisibleForTesting
    internal fun generate() {
        if (busy) return
        val include = selected()
        if (include.isEmpty()) return
        val previous = message.text.takeIf { it.isNotBlank() }
        working(KiloBundle.message("diff.commit.generating"))
        job = cs.launch {
            val result = runCatching { project.service<KiloSessionService>().generateCommitMessage(directory, include, previous) }
            withContext(Dispatchers.Main) {
                if (isDisposed) return@withContext
                result.onSuccess {
                    message.text = it
                    idle("")
                }.onFailure {
                    if (it is CancellationException) return@withContext idle("")
                    idle(KiloBundle.message("diff.commit.generateFailed", it.message ?: it.javaClass.simpleName))
                }
            }
        }
    }

    override fun doOKAction() = commit(push = false)

    private fun commit(push: Boolean) {
        if (busy || !okAction.isEnabled) return
        if (doValidate()?.let { setErrorText(it.message, it.component); true } == true) return
        val include = selected()
        val text = message.text
        working(KiloBundle.message("diff.commit.committing"))
        job = cs.launch {
            val workspace = service<KiloWorkspaceService>()
            val result = safely { workspace.commit(directory, text, include) }
            if (!result.ok) {
                withContext(Dispatchers.Main) {
                    if (!isDisposed) idle(KiloBundle.message("diff.commit.failed", result.error.orEmpty()))
                }
                return@launch
            }
            if (push) withContext(Dispatchers.Main) { if (!isDisposed) working(KiloBundle.message("diff.commit.pushing")) }
            val pushed = if (push) safely { workspace.push(directory) } else null
            withContext(Dispatchers.Main) {
                if (!isDisposed) close(OK_EXIT_CODE)
                val subject = text.lineSequence().first()
                when {
                    pushed == null -> KiloNotifications.info(project, KiloBundle.message("diff.commit.done", result.sha.orEmpty()), subject)
                    pushed.ok -> KiloNotifications.info(
                        project, KiloBundle.message("diff.commit.donePushed", result.sha.orEmpty(), pushed.sha.orEmpty()), subject,
                    )
                    // The commit stands; only the push needs another try.
                    else -> KiloNotifications.error(
                        project, KiloBundle.message("diff.commit.pushFailed", result.sha.orEmpty()), pushed.error,
                    )
                }
                committed(result.sha)
            }
        }
    }

    private suspend fun safely(call: suspend () -> CommitResultDto): CommitResultDto =
        runCatching { call() }.getOrElse {
            if (it is CancellationException) throw it
            CommitResultDto(false, error = it.message ?: it.javaClass.simpleName)
        }

    private fun working(text: String) {
        busy = true
        status.icon = AnimatedIcon.Default.INSTANCE
        status.text = text
        generate.isEnabled = false
        isOKActionEnabled = false
        pushAction.isEnabled = false
    }

    private fun idle(text: String) {
        busy = false
        status.icon = null
        status.text = text
        generate.isEnabled = paths.isNotEmpty()
        isOKActionEnabled = paths.isNotEmpty()
        pushAction.isEnabled = paths.isNotEmpty()
    }
}
