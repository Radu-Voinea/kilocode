package ai.kilocode.client.agentManager.worktree

import ai.kilocode.client.plugin.KiloBundle
import ai.kilocode.client.session.SessionActivityKind
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import java.awt.Color
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A color a worktree row can wear in Agent Manager. The palette is the user's own: these start as the
 * [DEFAULTS] and can be renamed, recolored, reordered, removed and added to. [id] is what a worktree stores,
 * so renaming or recoloring a color keeps every worktree that wears it.
 */
data class WorktreeColor(val id: String, val name: String, val rgb: Int) {
    /** Translucent, so the row text stays readable in any theme. */
    val fill: Color
        get() {
            val base = Color(rgb and 0xFFFFFF)
            return JBColor(Color(base.red, base.green, base.blue, 46), Color(base.red, base.green, base.blue, 64))
        }

    val swatch: Color get() = Color(rgb and 0xFFFFFF)

    val label: String get() = name

    /** One stored palette entry: `id|RRGGBB|name`. */
    internal fun encode(): String = "$id|${"%06X".format(rgb and 0xFFFFFF)}|$name"

    companion object {
        private val BUILTIN = listOf(
            "RED" to 0xE5534B, "ORANGE" to 0xE8853A, "YELLOW" to 0xD9B428, "GREEN" to 0x4FAF5B, "TEAL" to 0x2BA3A3,
            "BLUE" to 0x4A8FE7, "PURPLE" to 0x9B6FE0, "PINK" to 0xD8609E, "GRAY" to 0x8C8C8C,
        )

        /** The palette a project starts with. */
        val DEFAULTS: List<WorktreeColor>
            get() = BUILTIN.map { (id, rgb) -> WorktreeColor(id, KiloBundle.message("worktree.color.${id.lowercase()}"), rgb) }

        fun default(id: String): WorktreeColor = DEFAULTS.first { it.id == id }

        /** A new color with a fresh id. */
        fun create(name: String, rgb: Int): WorktreeColor =
            WorktreeColor("c" + java.util.UUID.randomUUID().toString().replace("-", "").take(10), name, rgb and 0xFFFFFF)

        internal fun decode(raw: String): WorktreeColor? {
            val parts = raw.split('|', limit = 3)
            if (parts.size < 3 || parts[0].isBlank()) return null
            val rgb = parts[1].toIntOrNull(16) ?: return null
            return WorktreeColor(parts[0], parts[2], rgb)
        }
    }
}

/** How Agent Manager orders worktrees. [MANUAL] is the drag-and-drop order. */
enum class WorktreeSort { MANUAL, NAME, STATUS, CHANGES }

/** How Agent Manager groups worktrees. [NONE] keeps the single "Local worktrees" group. */
enum class WorktreeGrouping { NONE, STATUS, COLOR, PREFIX }

/** What a worktree is doing, for sorting and grouping: something waiting on the user leads. */
enum class WorktreeState { ATTENTION, FINISHED, RUNNING, IDLE }

internal fun worktreeState(kind: SessionActivityKind?, finished: Boolean): WorktreeState = when (kind) {
    SessionActivityKind.PERMISSION,
    SessionActivityKind.QUESTION,
    SessionActivityKind.PLAN,
    SessionActivityKind.ERROR,
    SessionActivityKind.LOGIN_REQUIRED -> WorktreeState.ATTENTION
    SessionActivityKind.RUNNING -> WorktreeState.RUNNING
    null -> if (finished) WorktreeState.FINISHED else WorktreeState.IDLE
}

/** The part of a branch before its first `/` (`feature/x` → `feature`), or null for a flat name. */
internal fun branchPrefix(branch: String): String? = branch.substringBefore('/', "").takeIf { it.isNotBlank() }

/**
 * Per-project Agent Manager list preferences: row colors by worktree path, and the sort and grouping.
 * Colors are kept in the workspace file, so they never reach version control.
 */
@Service(Service.Level.PROJECT)
@State(name = "KiloWorktreeListView", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
class WorktreeListView(private val project: Project) : PersistentStateComponent<WorktreeListView.Data> {
    class Data {
        var colors: MutableMap<String, String> = mutableMapOf()
        /** Earlier releases kept only names and an order for the fixed colors; read once to build [palette]. */
        var names: MutableMap<String, String> = mutableMapOf()
        var order: MutableList<String> = mutableListOf()
        /** The user's palette as `id|RRGGBB|name` entries, once they have edited it. */
        var palette: MutableList<String> = mutableListOf()
        var customized: Boolean = false
    }

    private var data = Data()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    override fun getState(): Data = data

    override fun loadState(state: Data) {
        data = state
    }

    fun color(path: String): WorktreeColor? = data.colors[key(path)]?.let { id -> palette.firstOrNull { it.id == id } }

    fun setColor(path: String, color: WorktreeColor?) {
        if (color == null) data.colors.remove(key(path)) else data.colors[key(path)] = color.id
        changed()
    }

    /** The colors in the user's order, with their names and shades. */
    val palette: List<WorktreeColor>
        get() {
            if (data.customized) return data.palette.mapNotNull(WorktreeColor::decode).distinctBy { it.id }
            val defaults = WorktreeColor.DEFAULTS
            val saved = data.order.mapNotNull { id -> defaults.firstOrNull { it.id == id } }.distinct()
            return (saved + defaults.filter { it !in saved }).map { c ->
                data.names[c.id]?.takeIf { it.isNotBlank() }?.let { c.copy(name = it) } ?: c
            }
        }

    /** Replaces the palette. A worktree wearing a color that is no longer in it shows no color. */
    fun setPalette(colors: List<WorktreeColor>) {
        data.palette = colors.map { c -> c.copy(name = c.name.trim().ifEmpty { c.name }).encode() }.toMutableList()
        data.customized = true
        val ids = colors.map { it.id }.toSet()
        data.colors.values.removeIf { it !in ids }
        changed()
    }

    /** Back to the built-in palette. */
    fun resetPalette() {
        data.palette = mutableListOf()
        data.names = mutableMapOf()
        data.order = mutableListOf()
        data.customized = false
        changed()
    }

    var sort: WorktreeSort
        get() = props().getValue(SORT_KEY)?.let { v -> WorktreeSort.entries.firstOrNull { it.name == v } } ?: WorktreeSort.MANUAL
        set(value) {
            props().setValue(SORT_KEY, value.name, WorktreeSort.MANUAL.name)
            changed()
        }

    var grouping: WorktreeGrouping
        get() = props().getValue(GROUP_KEY)?.let { v -> WorktreeGrouping.entries.firstOrNull { it.name == v } } ?: WorktreeGrouping.NONE
        set(value) {
            props().setValue(GROUP_KEY, value.name, WorktreeGrouping.NONE.name)
            changed()
        }

    /** Drag-and-drop reordering only makes sense in the plain, hand-ordered list. */
    val manual: Boolean get() = sort == WorktreeSort.MANUAL && grouping == WorktreeGrouping.NONE

    fun addListener(listener: () -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }

    private fun changed() = listeners.forEach { it() }

    private fun props() = PropertiesComponent.getInstance(project)

    private fun key(path: String) = normalizeWorktreePath(path)

    private companion object {
        const val SORT_KEY = "kilo.worktree.sort"
        const val GROUP_KEY = "kilo.worktree.group"
    }
}
