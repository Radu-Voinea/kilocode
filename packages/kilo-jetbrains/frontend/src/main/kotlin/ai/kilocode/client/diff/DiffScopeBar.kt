package ai.kilocode.client.diff

import ai.kilocode.client.app.KiloWorkspaceService
import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.log.KiloLog
import ai.kilocode.rpc.dto.CommitDto
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.service
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.util.Disposer
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.awt.FlowLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * What a branch diff compares, picked above the diff: everything since the base branch, only the uncommitted
 * changes, or the last N commits of the branch. Every choice but "uncommitted only" can also take in the
 * working tree's uncommitted changes.
 */
internal sealed interface DiffScope {
    val from: String

    data object Branch : DiffScope {
        override val from = "base"
    }

    data object Uncommitted : DiffScope {
        override val from = "HEAD"
    }

    /** The newest [count] commits; [commit] is the oldest of them, which is how far back the diff reaches. */
    data class Commits(val count: Int, val commit: CommitDto?) : DiffScope {
        override val from: String get() = "HEAD~$count"
    }

    companion object {
        fun of(from: String?): DiffScope = when {
            from == null || from == "base" -> Branch
            from == "HEAD" -> Uncommitted
            from.startsWith("HEAD~") -> Commits(from.removePrefix("HEAD~").toIntOrNull() ?: 1, null)
            else -> Branch
        }
    }
}

internal fun scopeLabel(scope: DiffScope): String = when (scope) {
    DiffScope.Branch -> KiloBundle.message("diff.scope.branch")
    DiffScope.Uncommitted -> KiloBundle.message("diff.scope.uncommitted")
    is DiffScope.Commits -> {
        val subject = scope.commit?.let { "${it.short} ${it.subject}" }
        when {
            scope.count == 1 && subject != null -> KiloBundle.message("diff.scope.last", subject)
            scope.count == 1 -> KiloBundle.message("diff.scope.last.plain")
            subject != null -> KiloBundle.message("diff.scope.since", scope.count, subject)
            else -> KiloBundle.message("diff.scope.since.plain", scope.count)
        }
    }
}

/** The scope picker shown above branch and uncommitted diffs; [changed] receives the new `from` and uncommitted flag. */
internal class DiffScopeBar(
    params: Map<String, String>,
    private val cs: CoroutineScope,
    parent: Disposable,
    private val changed: (String, Boolean) -> Unit,
) {
    private val directory = params["directory"].orEmpty()
    private val model = DefaultComboBoxModel<DiffScope>()
    private val combo = ComboBox(model).apply {
        renderer = SimpleListCellRenderer.create("") { scopeLabel(it) }
        toolTipText = KiloBundle.message("diff.scope.tooltip")
    }
    private val working = JBCheckBox(KiloBundle.message("diff.scope.includeUncommitted"))
    private var syncing = false

    val component: JComponent = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(8), JBUI.scale(4))).apply {
        border = JBUI.Borders.customLineBottom(JBUI.CurrentTheme.CustomFrameDecorations.separatorForeground())
        add(JBLabel(KiloBundle.message("diff.scope.label")).apply { foreground = UIUtil.getContextHelpForeground() })
        add(combo)
        add(working)
    }

    init {
        val initial = when {
            params["from"] != null -> DiffScope.of(params["from"])
            params["source"] == "local" -> DiffScope.Uncommitted
            else -> DiffScope.Branch
        }
        val unc = params["uncommitted"]?.toBoolean() ?: (params["source"] == "local")
        fill(emptyList(), initial)
        working.isSelected = unc || initial == DiffScope.Uncommitted
        sync()
        combo.addActionListener {
            if (syncing) return@addActionListener
            if (selected() == DiffScope.Uncommitted) working.isSelected = true
            sync()
            emit()
        }
        working.addActionListener { if (!syncing) emit() }
        val job = cs.launch {
            val commits = runCatching { service<KiloWorkspaceService>().branchCommits(directory) }
                .getOrElse {
                    if (it is CancellationException) throw it
                    LOG.warn("diff scope commits failed dir=$directory", it)
                    emptyList()
                }
            withContext(Dispatchers.Main) { fill(commits, selected()) }
        }
        Disposer.register(parent) { job.cancel() }
    }

    internal fun selected(): DiffScope = combo.selectedItem as? DiffScope ?: DiffScope.Branch

    internal fun choices(): List<DiffScope> = (0 until model.size).map { model.getElementAt(it) }

    internal fun pick(scope: DiffScope) {
        combo.selectedItem = choices().firstOrNull { it.from == scope.from } ?: return
    }

    internal fun includeUncommitted(value: Boolean) {
        if (working.isSelected != value) working.doClick()
    }

    private fun fill(commits: List<CommitDto>, keep: DiffScope) {
        syncing = true
        try {
            model.removeAllElements()
            model.addElement(DiffScope.Branch)
            model.addElement(DiffScope.Uncommitted)
            commits.forEachIndexed { i, c -> model.addElement(DiffScope.Commits(i + 1, c)) }
            // A scope picked before the commits arrived (or from the file's parameters) stays selected.
            val match = choices().firstOrNull { it.from == keep.from }
            if (match == null && keep is DiffScope.Commits) model.addElement(keep)
            combo.selectedItem = match ?: keep
        } finally {
            syncing = false
        }
    }

    private fun sync() {
        working.isEnabled = selected() != DiffScope.Uncommitted
    }

    private fun emit() = changed(selected().from, working.isSelected)

    private companion object {
        private val LOG = KiloLog.create(DiffScopeBar::class.java)
    }
}
