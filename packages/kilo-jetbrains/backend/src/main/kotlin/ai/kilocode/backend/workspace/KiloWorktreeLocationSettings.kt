package ai.kilocode.backend.workspace

import com.intellij.ide.util.PropertiesComponent
import java.nio.file.InvalidPathException
import java.nio.file.Path

/**
 * Where Agent Manager puts the worktrees it creates. The value is a directory, absolute or relative
 * to the repository's main working tree, and may use `{repo}` for that tree's folder name and `~` for
 * the home directory. Blank means the default, `.kilo/worktrees`.
 *
 * Only the location of new worktrees depends on this; Kilo lists every worktree git reports, and
 * deletes only the ones it created.
 */
object KiloWorktreeLocationSettings {
    const val DEFAULT = ".kilo/worktrees"
    private const val KEY = "kilo.worktreeLocation"

    @Volatile
    private var fallback = ""

    fun get(): String = props()?.getValue(KEY, "") ?: fallback

    fun set(value: String) {
        val clean = value.trim()
        fallback = clean
        props()?.setValue(KEY, clean, "")
    }

    /** The directory new worktrees of the repository at [root] go into, or null when [value] is not a usable path. */
    fun resolve(root: Path, value: String = get(), home: String = com.intellij.util.SystemProperties.getUserHome()): Path? {
        val raw = value.trim().ifEmpty { DEFAULT }
        val name = root.normalize().fileName?.toString().orEmpty()
        val text = raw.replace("{repo}", name).let {
            if (it == "~") home else if (it.startsWith("~/")) home + it.substring(1) else it
        }
        return try {
            val path = Path.of(text)
            (if (path.isAbsolute) path else root.resolve(path)).normalize()
        } catch (_: InvalidPathException) {
            null
        }
    }

    private fun props(): PropertiesComponent? = runCatching { PropertiesComponent.getInstance() }.getOrNull()
}
