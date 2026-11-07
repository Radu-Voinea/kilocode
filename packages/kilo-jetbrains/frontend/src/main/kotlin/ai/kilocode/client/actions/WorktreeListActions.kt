package ai.kilocode.client.actions

import ai.kilocode.client.agentManager.SidePanelKeys
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
