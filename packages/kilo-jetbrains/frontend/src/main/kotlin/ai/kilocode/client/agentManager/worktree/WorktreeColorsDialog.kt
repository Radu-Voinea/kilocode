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

/** Renames and reorders the worktree colors of one project. The order is the Color menu and color groups order. */
class WorktreeColorsDialog(project: Project, private val view: WorktreeListView) : DialogWrapper(project) {
    private val model = Model(view.palette.map { Entry(it, view.label(it)) }.toMutableList())
    private val table = JBTable(model)

    init {
        title = KiloBundle.message("worktree.colors.title")
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
        table.setRowSelectionInterval(0, 0)
        init()
    }

    override fun createCenterPanel(): JComponent =
        ToolbarDecorator.createDecorator(table)
            .disableAddAction()
            .disableRemoveAction()
            .createPanel()
            .apply { preferredSize = JBUI.size(320, 300) }

    override fun getPreferredFocusedComponent(): JComponent = table

    override fun doOKAction() {
        if (table.isEditing) table.cellEditor?.stopCellEditing()
        view.setPalette(model.rows.map { it.color }, model.rows.associate { it.color to it.name })
        super.doOKAction()
    }

    /** What the dialog would save, for tests. */
    internal val rows: List<Pair<WorktreeColor, String>> get() = model.rows.map { it.color to it.name }

    internal fun move(from: Int, to: Int) = model.exchangeRows(from, to)

    internal fun rename(row: Int, name: String) = model.setValueAt(name, row, 1)

    internal fun save() = doOKAction()

    private class Entry(val color: WorktreeColor, var name: String)

    private class Model(val rows: MutableList<Entry>) : AbstractTableModel(), EditableModel {
        override fun getRowCount(): Int = rows.size

        override fun getColumnCount(): Int = 2

        override fun getColumnName(column: Int): String =
            if (column == 0) "" else KiloBundle.message("worktree.colors.name")

        override fun getValueAt(row: Int, column: Int): Any = if (column == 0) rows[row].color else rows[row].name

        override fun isCellEditable(row: Int, column: Int): Boolean = column == 1

        override fun setValueAt(value: Any?, row: Int, column: Int) {
            if (column != 1) return
            rows[row].name = value?.toString().orEmpty()
            fireTableCellUpdated(row, column)
        }

        override fun addRow() = Unit

        override fun removeRow(idx: Int) = Unit

        override fun canExchangeRows(oldIndex: Int, newIndex: Int): Boolean =
            oldIndex in rows.indices && newIndex in rows.indices

        override fun exchangeRows(oldIndex: Int, newIndex: Int) {
            val moved = rows.removeAt(oldIndex)
            rows.add(newIndex, moved)
            fireTableDataChanged()
        }
    }
}
