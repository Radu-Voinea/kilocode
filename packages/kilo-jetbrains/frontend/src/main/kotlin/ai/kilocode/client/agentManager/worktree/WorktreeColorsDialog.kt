package ai.kilocode.client.agentManager.worktree

import ai.kilocode.client.plugin.KiloBundle
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.ToolbarDecorator
import com.intellij.ui.table.JBTable
import com.intellij.util.ui.EditableModel
import com.intellij.util.ui.JBUI
import java.awt.Color
import java.awt.Component
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JTable
import javax.swing.ListSelectionModel
import javax.swing.table.AbstractTableModel
import javax.swing.table.DefaultTableCellRenderer

/** A round color swatch, as shown next to color names in menus, group headers and the colors dialog. */
class ColorDotIcon(private val color: Color, private val size: Int = 12) : Icon {
    override fun getIconWidth(): Int = JBUI.scale(size)

    override fun getIconHeight(): Int = JBUI.scale(size)

    override fun paintIcon(c: Component?, g: Graphics, x: Int, y: Int) {
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            val d = JBUI.scale(size)
            val inset = JBUI.scale(1)
            g2.color = color
            g2.fillOval(x + inset, y + inset, d - inset * 2, d - inset * 2)
        } finally {
            g2.dispose()
        }
    }
}

/**
 * Edits the worktree colors of one project: add, remove, rename, recolor and reorder. The order is the Color
 * menu and color groups order. Double-click a swatch (or use the paint button) to pick its shade.
 */
class WorktreeColorsDialog(project: Project, private val view: WorktreeListView) : DialogWrapper(project) {
    private val model = Model(view.palette.toMutableList())
    private val table = JBTable(model)
    private var reset = false

    init {
        title = KiloBundle.message("worktree.colors.title")
        setOKButtonText(KiloBundle.message("worktree.colors.save"))
        table.setShowGrid(false)
        table.tableHeader.reorderingAllowed = false
        table.selectionModel.selectionMode = ListSelectionModel.SINGLE_SELECTION
        table.columnModel.getColumn(0).apply {
            val w = JBUI.scale(28)
            minWidth = w
            maxWidth = w
            cellRenderer = object : DefaultTableCellRenderer() {
                override fun getTableCellRendererComponent(
                    table: JTable, value: Any?, isSelected: Boolean, hasFocus: Boolean, row: Int, column: Int,
                ): Component {
                    super.getTableCellRendererComponent(table, "", isSelected, false, row, column)
                    icon = (value as? WorktreeColor)?.let { ColorDotIcon(it.swatch) }
                    horizontalAlignment = CENTER
                    return this
                }
            }
        }
        table.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) {
                if (e.clickCount == 2 && table.columnAtPoint(e.point) == 0) recolor(table.rowAtPoint(e.point))
            }
        })
        if (model.rowCount > 0) table.setRowSelectionInterval(0, 0)
        init()
    }

    override fun createCenterPanel(): JComponent =
        ToolbarDecorator.createDecorator(table)
            .setAddAction { add() }
            .setRemoveAction { remove(table.selectedRow) }
            .addExtraAction(object : com.intellij.openapi.project.DumbAwareAction(
                KiloBundle.message("worktree.colors.recolor"), null, com.intellij.icons.AllIcons.Actions.Colors,
            ) {
                override fun getActionUpdateThread() = com.intellij.openapi.actionSystem.ActionUpdateThread.EDT

                override fun update(e: com.intellij.openapi.actionSystem.AnActionEvent) {
                    e.presentation.isEnabled = table.selectedRow >= 0
                }

                override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent) = recolor(table.selectedRow)
            })
            .addExtraAction(object : com.intellij.openapi.project.DumbAwareAction(
                KiloBundle.message("worktree.colors.reset"), null, com.intellij.icons.AllIcons.Actions.Rollback,
            ) {
                override fun getActionUpdateThread() = com.intellij.openapi.actionSystem.ActionUpdateThread.EDT

                override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent) = restore()
            })
            .createPanel()
            .apply { preferredSize = JBUI.size(340, 320) }

    override fun getPreferredFocusedComponent(): JComponent = table

    override fun doOKAction() {
        if (table.isEditing) table.cellEditor?.stopCellEditing()
        if (reset && model.rows == WorktreeColor.DEFAULTS) view.resetPalette() else view.setPalette(model.rows.toList())
        super.doOKAction()
    }

    private fun add() {
        val used = model.rows.map { it.rgb }.toSet()
        val seed = WorktreeColor.DEFAULTS.firstOrNull { it.rgb !in used }?.swatch ?: Color(0x4A8FE7)
        val picked = pick(seed) ?: return
        insert(WorktreeColor.create(KiloBundle.message("worktree.colors.new"), picked.rgb))
        val row = model.rowCount - 1
        table.setRowSelectionInterval(row, row)
        table.editCellAt(row, 1)
        table.editorComponent?.requestFocusInWindow()
    }

    private fun recolor(row: Int) {
        if (row !in 0 until model.rowCount) return
        val picked = pick(model.rows[row].swatch) ?: return
        model.update(row) { it.copy(rgb = picked.rgb and 0xFFFFFF) }
    }

    private fun pick(start: Color): Color? =
        com.intellij.ui.ColorChooserService.getInstance().showDialog(table, KiloBundle.message("worktree.colors.pick"), start, false)

    /** What the dialog would save, for tests. */
    internal val rows: List<WorktreeColor> get() = model.rows.toList()

    internal fun insert(color: WorktreeColor) = model.insert(color)

    internal fun remove(row: Int) {
        if (row !in 0 until model.rowCount) return
        model.removeRow(row)
        if (model.rowCount > 0) {
            val next = row.coerceAtMost(model.rowCount - 1)
            table.setRowSelectionInterval(next, next)
        }
    }

    internal fun restore() {
        if (table.isEditing) table.cellEditor?.cancelCellEditing()
        model.replace(WorktreeColor.DEFAULTS)
        reset = true
    }

    internal fun move(from: Int, to: Int) = model.exchangeRows(from, to)

    internal fun rename(row: Int, name: String) = model.setValueAt(name, row, 1)

    internal fun save() = doOKAction()

    private class Model(val rows: MutableList<WorktreeColor>) : AbstractTableModel(), EditableModel {
        override fun getRowCount(): Int = rows.size

        override fun getColumnCount(): Int = 2

        override fun getColumnName(column: Int): String =
            if (column == 0) "" else KiloBundle.message("worktree.colors.name")

        override fun getValueAt(row: Int, column: Int): Any = if (column == 0) rows[row] else rows[row].name

        override fun isCellEditable(row: Int, column: Int): Boolean = column == 1

        override fun setValueAt(value: Any?, row: Int, column: Int) {
            if (column != 1) return
            val name = value?.toString()?.trim().orEmpty()
            if (name.isEmpty()) return
            update(row) { it.copy(name = name) }
        }

        fun update(row: Int, change: (WorktreeColor) -> WorktreeColor) {
            rows[row] = change(rows[row])
            fireTableRowsUpdated(row, row)
        }

        fun insert(color: WorktreeColor) {
            rows += color
            fireTableRowsInserted(rows.size - 1, rows.size - 1)
        }

        fun replace(colors: List<WorktreeColor>) {
            rows.clear()
            rows += colors
            fireTableDataChanged()
        }

        override fun addRow() = Unit

        override fun removeRow(idx: Int) {
            rows.removeAt(idx)
            fireTableRowsDeleted(idx, idx)
        }

        override fun canExchangeRows(oldIndex: Int, newIndex: Int): Boolean =
            oldIndex in rows.indices && newIndex in rows.indices

        override fun exchangeRows(oldIndex: Int, newIndex: Int) {
            val moved = rows.removeAt(oldIndex)
            rows.add(newIndex, moved)
            fireTableDataChanged()
        }
    }
}
