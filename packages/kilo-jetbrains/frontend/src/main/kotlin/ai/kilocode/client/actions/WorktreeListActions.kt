package ai.kilocode.client.actions

import ai.kilocode.client.agentManager.SidePanelKeys
import ai.kilocode.client.agentManager.SidePanelMode
import ai.kilocode.client.agentManager.worktree.ColorDotIcon
import ai.kilocode.client.agentManager.worktree.WorktreeColor
import ai.kilocode.client.agentManager.worktree.WorktreeColorsDialog
import ai.kilocode.client.agentManager.worktree.WorktreeGrouping
import ai.kilocode.client.agentManager.worktree.WorktreeListView
import ai.kilocode.client.agentManager.worktree.WorktreeSort
import ai.kilocode.client.plugin.KiloBundle
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.components.service
import com.intellij.openapi.ui.popup.JBPopupFactory
import ai.kilocode.client.agentManager.worktree.WorktreeDataKeys
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware

/** Takes a worktree Kilo did not create off the Agent Manager list; it stays on disk and in git. */
class HideWorktreeAction : AnAction(), DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        val panel = e.getData(SidePanelKeys.WORKTREE_PANEL)
        val item = e.getData(WorktreeDataKeys.WORKTREE)
        e.presentation.isEnabledAndVisible = panel != null && panel.canHide(item)
    }

    override fun actionPerformed(e: AnActionEvent) {
        val panel = e.getData(SidePanelKeys.WORKTREE_PANEL) ?: return
        val item = e.getData(WorktreeDataKeys.WORKTREE) ?: return
        panel.hide(item)
    }
}

/** Picks a folder and lists it in Agent Manager when it is a worktree of this repository. */
class AddExistingWorktreeAction : AnAction(), DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.getData(SidePanelKeys.WORKTREE_PANEL) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        e.getData(SidePanelKeys.WORKTREE_PANEL)?.addExisting()
    }
}

/** "Color" submenu on a worktree row: a background color to tell worktrees apart, or none. */
class WorktreeColorGroup : com.intellij.openapi.actionSystem.ActionGroup(), DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun update(e: AnActionEvent) {
        val panel = e.getData(SidePanelKeys.WORKTREE_PANEL)
        e.presentation.isPopupGroup = true
        e.presentation.isEnabledAndVisible = panel != null && panel.canColor(e.getData(WorktreeDataKeys.WORKTREE))
    }

    override fun getChildren(e: AnActionEvent?): Array<AnAction> {
        val view = e?.project?.service<WorktreeListView>()
        val colors = view?.palette ?: WorktreeColor.DEFAULTS
        return (colors.map { SetColor(it, it.name) } +
            com.intellij.openapi.actionSystem.Separator.create() +
            SetColor(null, KiloBundle.message("worktree.color.none")) +
            com.intellij.openapi.actionSystem.Separator.create() +
            ManageWorktreeColorsAction()).toTypedArray()
    }

    /**
     * A plain action, not a ToggleAction: menus draw a toggle's check where its icon goes, which hid the color
     * dots. The current color gets the check next to its dot instead.
     */
    private class SetColor(private val color: WorktreeColor?, text: String) : AnAction(text), DumbAware {
        override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

        override fun update(e: AnActionEvent) {
            val current = e.getData(SidePanelKeys.WORKTREE_PANEL)?.worktreeColor(e.getData(WorktreeDataKeys.WORKTREE))
            val mark = if (current == color) com.intellij.icons.AllIcons.Actions.Checked else com.intellij.util.ui.EmptyIcon.ICON_16
            val dot: javax.swing.Icon = color?.let { ColorDotIcon(it.swatch) } ?: com.intellij.util.ui.EmptyIcon.create(12)
            e.presentation.icon = com.intellij.ui.RowIcon(mark, dot)
        }

        override fun actionPerformed(e: AnActionEvent) {
            val panel = e.getData(SidePanelKeys.WORKTREE_PANEL) ?: return
            val item = e.getData(WorktreeDataKeys.WORKTREE) ?: return
            panel.setWorktreeColor(item, color)
        }
    }
}

/** Opens the dialog that renames and reorders the worktree colors of this project. */
class ManageWorktreeColorsAction : AnAction(
    KiloBundle.message("worktree.colors.manage"),
    KiloBundle.message("worktree.colors.manage.description"),
    null,
), DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        WorktreeColorsDialog(project, project.service<WorktreeListView>()).show()
    }
}

/** Title-bar button in Agent Manager that opens the sort and group choices for the worktree list. */
class WorktreeViewOptionsAction : AnAction(
    KiloBundle.message("action.Kilo.Worktree.ViewOptions.text"),
    KiloBundle.message("action.Kilo.Worktree.ViewOptions.description"),
    com.intellij.icons.AllIcons.Actions.GroupBy,
), DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isVisible = e.getData(SidePanelKeys.MODE) == SidePanelMode.AGENT_MANAGER
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val view = project.service<WorktreeListView>()
        val group = DefaultActionGroup()
        group.addSeparator(KiloBundle.message("worktree.view.sort"))
        WorktreeSort.entries.forEach { sort ->
            group.add(choice(KiloBundle.message("worktree.view.sort.${sort.name.lowercase()}"), { view.sort == sort }) { view.sort = sort })
        }
        group.addSeparator(KiloBundle.message("worktree.view.group"))
        WorktreeGrouping.entries.forEach { grouping ->
            group.add(choice(KiloBundle.message("worktree.view.group.${grouping.name.lowercase()}"), { view.grouping == grouping }) { view.grouping = grouping })
        }
        group.addSeparator()
        group.add(ManageWorktreeColorsAction())
        val popup = JBPopupFactory.getInstance().createActionGroupPopup(
            null, group, e.dataContext, JBPopupFactory.ActionSelectionAid.SPEEDSEARCH, true,
        )
        val source = e.inputEvent?.component
        if (source != null) popup.showUnderneathOf(source) else popup.showInBestPositionFor(e.dataContext)
    }

    private fun choice(text: String, selected: () -> Boolean, pick: () -> Unit): AnAction =
        object : com.intellij.openapi.actionSystem.ToggleAction(text), DumbAware {
            override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

            override fun isSelected(e: AnActionEvent): Boolean = selected()

            override fun setSelected(e: AnActionEvent, state: Boolean) = pick()
        }
}
