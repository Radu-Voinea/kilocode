package ai.kilocode.client.review

import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.ui.UiStyle
import com.intellij.icons.AllIcons
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.ui.JBColor
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextArea
import com.intellij.util.concurrency.annotations.RequiresEdt
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Color
import java.awt.FlowLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * The inline card of one review comment, shown under its lines in the diff. It writes a new comment
 * (draft), edits one, or shows a saved one. The header names the lines and the session or worktree
 * the review goes to; the target link changes it for the whole review.
 */
internal class ReviewCard(
    private val project: Project,
    private val scope: ReviewScope,
    private val side: ReviewSide,
    private val start: Int,
    private val end: Int,
    private var comment: ReviewComment?,
    private val save: (String) -> Unit,
    private val cancel: () -> Unit,
    private val delete: () -> Unit,
) : JPanel(BorderLayout()) {
    private val service get() = project.service()
    private val target = ActionLink("") { chooseTarget() }.apply {
        setDropDownLinkIcon()
        toolTipText = KiloBundle.message("review.card.target.tooltip")
    }
    private val area = JBTextArea(3, 40).apply {
        lineWrap = true
        wrapStyleWord = true
        emptyText.text = KiloBundle.message("review.card.placeholder")
        border = JBUI.Borders.empty(UiStyle.Gap.sm())
        addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && (e.isControlDown || e.isMetaDown)) {
                    e.consume()
                    commit()
                } else if (e.keyCode == KeyEvent.VK_ESCAPE) {
                    e.consume()
                    stopEditing()
                }
            }
        })
    }
    private val body = JPanel(BorderLayout()).apply { isOpaque = false }

    init {
        isOpaque = true
        background = cardBackground()
        border = JBUI.Borders.compound(
            JBUI.Borders.empty(UiStyle.Gap.xs(), UiStyle.Gap.sm(), UiStyle.Gap.sm(), UiStyle.Gap.lg()),
            JBUI.Borders.customLine(JBColor.border(), 1),
            JBUI.Borders.empty(UiStyle.Gap.sm(), UiStyle.Gap.pad()),
        )
        add(header(), BorderLayout.NORTH)
        add(body, BorderLayout.CENTER)
        refreshTarget()
        if (comment == null) edit() else showSaved()
    }

    val editing: Boolean get() = area.isShowing

    @RequiresEdt
    fun refreshTarget() {
        target.text = service.target(scope).label
    }

    fun focusText() {
        area.requestFocusInWindow()
    }

    private fun header(): JComponent {
        val row = JPanel(BorderLayout()).apply { isOpaque = false }
        val where = buildString {
            append(lines())
            append(" · ")
            append(KiloBundle.message(if (side == ReviewSide.NEW) "review.card.side.new" else "review.card.side.old"))
        }
        row.add(JBLabel(where, AllIcons.General.Balloon, JBLabel.LEADING).apply { foreground = UiStyle.Colors.weak() }, BorderLayout.WEST)
        row.add(target, BorderLayout.EAST)
        row.border = JBUI.Borders.emptyBottom(UiStyle.Gap.sm())
        return row
    }

    private fun lines(): String =
        if (start == end) KiloBundle.message("review.card.line", start) else KiloBundle.message("review.card.lines", start, end)

    private fun edit() {
        body.removeAll()
        area.text = comment?.text.orEmpty()
        body.add(area, BorderLayout.CENTER)
        val buttons = JPanel(FlowLayout(FlowLayout.RIGHT, UiStyle.Gap.sm(), 0)).apply { isOpaque = false }
        buttons.add(JButton(KiloBundle.message("review.card.cancel")).apply { addActionListener { stopEditing() } })
        val ok = JButton(KiloBundle.message(if (comment == null) "review.card.add" else "review.card.save")).apply {
            addActionListener { commit() }
            putClientProperty("JButton.buttonType", "default")
        }
        buttons.add(ok)
        buttons.border = JBUI.Borders.emptyTop(UiStyle.Gap.sm())
        body.add(buttons, BorderLayout.SOUTH)
        relayout()
    }

    private fun showSaved() {
        val item = comment ?: return
        body.removeAll()
        val text = JBTextArea(item.text).apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            isOpaque = false
            border = JBUI.Borders.empty()
        }
        body.add(text, BorderLayout.CENTER)
        val links = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = false
            border = JBUI.Borders.emptyTop(UiStyle.Gap.sm())
            add(ActionLink(KiloBundle.message("review.card.edit")) { edit(); focusText() })
            add(javax.swing.Box.createHorizontalStrut(UiStyle.Gap.lg()))
            add(ActionLink(KiloBundle.message("review.card.delete")) { delete() })
        }
        body.add(links, BorderLayout.SOUTH)
        relayout()
    }

    private fun commit() {
        val text = area.text.trim()
        if (text.isEmpty()) return
        save(text)
    }

    private fun stopEditing() {
        if (comment == null) cancel() else showSaved()
    }

    private fun chooseTarget() {
        val options = service.targets(scope)
        val step = object : BaseListPopupStep<ReviewTarget>(KiloBundle.message("review.target.choose"), options) {
            override fun getTextFor(value: ReviewTarget): String = value.label

            override fun onChosen(selectedValue: ReviewTarget, finalChoice: Boolean): PopupStep<*>? {
                service.choose(scope, selectedValue)
                return FINAL_CHOICE
            }
        }
        step.defaultOptionIndex = options.indexOfFirst { it.label == target.text }.coerceAtLeast(0)
        JBPopupFactory.getInstance().createListPopup(step).showUnderneathOf(target)
    }

    private fun relayout() {
        revalidate()
        repaint()
    }

    private fun Project.service(): KiloReviewService = getService(KiloReviewService::class.java)

    private companion object {
        fun cardBackground(): Color = JBColor.lazy { UIUtil.getPanelBackground() }
    }
}
