package ai.kilocode.client.review

import ai.kilocode.client.KiloNotifications
import ai.kilocode.client.plugin.KiloBundle
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.ui.EditorNotificationPanel
import com.intellij.util.concurrency.annotations.RequiresEdt

/**
 * The bar over a Kilo diff while its review has comments: how many, where they go, and the actions
 * that submit the review to the agent, change its target, or discard it.
 */
internal class ReviewBar(
    private val project: Project,
    private val scope: ReviewScope,
    parent: Disposable,
) : EditorNotificationPanel(Status.Info) {
    private val service = project.service<KiloReviewService>()

    init {
        createActionLabel(KiloBundle.message("review.bar.submit")) { submit() }
        createActionLabel(KiloBundle.message("review.bar.target")) { chooseTarget() }
        createActionLabel(KiloBundle.message("review.bar.discard")) { discard() }
        service.listen(parent) { key -> if (key.isEmpty() || key == scope.key) update() }
        update()
    }

    @RequiresEdt
    fun update() {
        val count = service.comments(scope).size
        isVisible = count > 0
        if (count > 0) text(KiloBundle.message("review.bar.text", count, service.target(scope).label))
        revalidate()
        repaint()
    }

    private fun submit() {
        val target = service.target(scope)
        if (service.submit(scope)) {
            KiloNotifications.info(project, KiloBundle.message("review.submitted.title"), KiloBundle.message("review.submitted.text", target.label))
        }
    }

    private fun discard() {
        val count = service.comments(scope).size
        if (count == 0) return
        val ok = Messages.showYesNoDialog(
            project,
            KiloBundle.message("review.discard.message", count),
            KiloBundle.message("review.discard.title"),
            Messages.getQuestionIcon(),
        ) == Messages.YES
        if (ok) service.discard(scope)
    }

    private fun chooseTarget() {
        val options = service.targets(scope)
        val current = service.target(scope)
        val step = object : BaseListPopupStep<ReviewTarget>(KiloBundle.message("review.target.choose"), options) {
            override fun getTextFor(value: ReviewTarget): String = value.label

            override fun onChosen(selectedValue: ReviewTarget, finalChoice: Boolean): PopupStep<*>? {
                service.choose(scope, selectedValue)
                return FINAL_CHOICE
            }
        }
        step.defaultOptionIndex = options.indexOf(current).coerceAtLeast(0)
        JBPopupFactory.getInstance().createListPopup(step).showUnderneathOf(this)
    }
}
