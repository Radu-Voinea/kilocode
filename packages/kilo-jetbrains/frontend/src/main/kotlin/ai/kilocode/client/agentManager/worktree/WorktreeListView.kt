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

/** Colors a worktree row can wear in Agent Manager. Translucent so the row text stays readable in any theme. */
enum class WorktreeColor(private val rgb: Int) {
    RED(0xE5534B),
    ORANGE(0xE8853A),
    YELLOW(0xD9B428),
    GREEN(0x4FAF5B),
    TEAL(0x2BA3A3),
    BLUE(0x4A8FE7),
    PURPLE(0x9B6FE0),
    PINK(0xD8609E),
    GRAY(0x8C8C8C);

    val fill: Color
        get() {
            val base = Color(rgb)
            return JBColor(Color(base.red, base.green, base.blue, 46), Color(base.red, base.green, base.blue, 64))
        }

    val swatch: Color get() = Color(rgb)

    val label: String get() = KiloBundle.message("worktree.color.${name.lowercase()}")
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
    }

    private var data = Data()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()

    override fun getState(): Data = data

    override fun loadState(state: Data) {
        data = state
    }

    fun color(path: String): WorktreeColor? =
        data.colors[key(path)]?.let { name -> WorktreeColor.entries.firstOrNull { it.name == name } }

    fun setColor(path: String, color: WorktreeColor?) {
        if (color == null) data.colors.remove(key(path)) else data.colors[key(path)] = color.name
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
